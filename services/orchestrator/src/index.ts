import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { buildEnvelope, consumeRabbitQueue, publishRabbitEvent, readPayload, startHeartbeat, type EventEnvelope } from 'shared';
import { PrismaRepository } from './db.js';
import { createApiRouter, resolveContainerTarget } from './api.js';
import { verifyToken } from './auth.js';
import { pipeSockets, toWsUrl, type DuplexSocket } from './wsProxy.js';
import { createBillingProxyRouter } from './billingProxy.js';
import { createMonitoringRouter } from './monitoring.js';
import { createConfigRouter } from './config.js';
import { createAuthRouter, requireAuth } from './auth.js';
import { createNodeRegistry } from './nodeRegistry.js';
import { createLifecycle } from './lifecycle.js';
import { createSuspendHandler, type SuspendPayload } from './suspend.js';
import { startScheduler, type ScheduleActions } from './scheduler.js';

// ── Orchestrator ────────────────────────────────────────────────────────────
// Turns deployment requests into running containers. It keeps a node registry
// from heartbeats, places deployments on the least-loaded node (api.ts), commands
// the Node Agent over the shared bus, and updates deployment state from the
// agent's lifecycle reports.

const PORT = Number(process.env.PORT) || 9200;
const NODE_AGENT_URL = process.env.NODE_AGENT_URL || 'http://node-agent:9100';

const repo = new PrismaRepository();
const registry = createNodeRegistry(repo);
const lifecycle = createLifecycle(repo);
const suspend = createSuspendHandler({ repo });

// Actions the schedule runner (#111) performs for a due schedule: restart the
// server (over the bus) or snapshot a backup (via the owning node agent).
const scheduleActions: ScheduleActions = {
  async restart(deploymentId) {
    const detail = await repo.getDeployment(deploymentId);
    if (!detail?.containerId || !detail.nodeId) return;
    await publishRabbitEvent(
      'infra.server.restart',
      buildEnvelope('orchestrator', { type: 'server.restart', payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId } })
    );
    await repo.appendDeploymentEvent(detail.id, 'schedule-restart', 'restarted by schedule');
  },
  async backup(deploymentId) {
    const detail = await repo.getDeployment(deploymentId);
    if (!detail?.containerId) return;
    const r = await fetch(`${NODE_AGENT_URL}/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ containerId: detail.containerId }) });
    if (!r.ok) throw new Error('scheduled backup failed');
    const snap = (await r.json()) as { ref: string; sizeBytes: number; path: string };
    await repo.createBackup({ deploymentId: detail.id, name: `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`, path: snap.path, ref: snap.ref, sizeBytes: snap.sizeBytes });
    await repo.appendDeploymentEvent(detail.id, 'schedule-backup', 'snapshot created by schedule');
  },
};

// ── HTTP: API + health probe ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ service: 'orchestrator', status: 'healthy', uptimeSec: Math.round(process.uptime()) });
});
// Public runtime config (edition flag) — read by the dashboard before login.
app.use(createConfigRouter());
// Public login, then everything below requires a valid Bearer token.
app.use(createAuthRouter());
app.use(requireAuth);
app.use(createApiRouter({ repo, scheduleActions }));
// Authenticated billing proxy → Billing Bridge (hosted edition; injects the JWT user id).
app.use(createBillingProxyRouter());
// Surfaces the Control Room's live service/node monitoring to the dashboard (#157).
app.use(createMonitoringRouter());

// ── WebSocket: interactive terminal proxy (#71) ───────────────────────────────
// The dashboard opens ws://…/deployments/:id/terminal?token=<jwt>. We validate the
// JWT, resolve the owning container, dial the Node Agent's internal /terminal WS,
// and pipe the two together.
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

/** Adapt a `ws` socket to the DuplexSocket the pipe expects. */
function toDuplex(ws: WebSocket): DuplexSocket {
  return {
    on(event, cb) {
      if (event === 'message') ws.on('message', (data: RawData) => (cb as (d: string) => void)(data.toString()));
      else ws.on('close', cb as () => void);
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://orchestrator');
  const match = /^\/deployments\/([^/]+)\/terminal$/.exec(url.pathname);
  if (!match) return socket.destroy();

  // Auth: the JWT rides as a query param (browsers can't set WS headers).
  const token = url.searchParams.get('token');
  if (!token) return socket.destroy();
  try {
    verifyToken(token);
  } catch {
    return socket.destroy();
  }

  const target = resolveContainerTarget(await repo.getDeployment(match[1]));
  if (target.status !== 200) return socket.destroy();

  const cols = url.searchParams.get('cols') ?? '80';
  const rows = url.searchParams.get('rows') ?? '24';
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstream = new WebSocket(`${toWsUrl(NODE_AGENT_URL)}/terminal/${target.containerId}?cols=${cols}&rows=${rows}`);
    upstream.on('open', () => pipeSockets(toDuplex(clientWs), toDuplex(upstream)));
    upstream.on('error', () => clientWs.close());
  });
});

server.listen(PORT, () => console.log(`[Orchestrator] HTTP + WS listening on http://localhost:${PORT}`));

// Evaluate schedules once a minute (restart/backup on a cron).
startScheduler(repo, scheduleActions);
console.log('[Orchestrator] Schedule runner started (1-minute tick)');

// ── Event bus: node heartbeats + server lifecycle reports ─────────────────────
async function start() {
  try {
    await consumeRabbitQueue(
      'nexusinfra.orchestrator',
      ['monitoring.heartbeat.node.#', 'infra.server.started', 'infra.server.stopped', 'infra.server.crashed', 'billing.server.suspend'],
      async (envelope: EventEnvelope) => {
        if (envelope.event.type === 'heartbeat.node') {
          await registry.handleHeartbeat(envelope);
        } else if (envelope.event.type === 'billing.server.suspend') {
          await suspend(readPayload(envelope.event) as unknown as SuspendPayload);
        } else {
          await lifecycle.handleReport(envelope);
        }
      }
    );
    console.log('[Orchestrator] Consuming node heartbeats + server lifecycle reports');

    startHeartbeat('orchestrator', 1000);
    console.log('[Orchestrator] Publishing heartbeat on monitoring.heartbeat.service.orchestrator');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Orchestrator] Failed to connect to event bus:', message);
    console.error('[Orchestrator] HTTP API remains available; set RABBITMQ_URL to enable orchestration.');
  }
}

void start();

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
