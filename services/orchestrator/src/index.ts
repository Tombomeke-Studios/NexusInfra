import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { assertEditionIsRunnable, buildEnvelope, buildInfo, consumeRabbitQueue, getInternalToken, INTERNAL_TOKEN_HEADER, publishRabbitEvent, readPayload, startHeartbeat, type EventEnvelope } from 'shared';
import { PrismaRepository } from './db.js';
import { agentFetch, createApiRouter, resolveContainerTarget } from './api.js';
import { resolveAgentUrl } from './agentUrl.js';
import { verifyToken } from './auth.js';
import { can, resolveRole } from './access.js';
import { pipeSockets, toWsUrl, type DuplexSocket } from './wsProxy.js';
import { createBillingProxyRouter } from './billingProxy.js';
import { createMonitoringRouter } from './monitoring.js';
import { createConfigRouter } from './config.js';
import { createAccountRouter, createAuthRouter, createRequireAuth, createUserAdminRouter } from './auth.js';
import { createUserService } from './users.js';
import { createTeamRouter } from './teams.js';
import { createNodeRegistry } from './nodeRegistry.js';
import { createLifecycle } from './lifecycle.js';
import { createSuspendHandler, type SuspendPayload } from './suspend.js';
import { startScheduler, type ScheduleActions } from './scheduler.js';

// ── Orchestrator ────────────────────────────────────────────────────────────
// Turns deployment requests into running containers. It keeps a node registry
// from heartbeats, places deployments on the least-loaded node (api.ts), commands
// the Node Agent over the shared bus, and updates deployment state from the
// agent's lifecycle reports.

// Refuse to run this image as an edition it was not built for (#189): the
// community images do not contain the hosted code, so starting anyway would mean
// a half-enabled billing system rather than a working one.
try {
  assertEditionIsRunnable();
} catch (err) {
  console.error(`[Orchestrator] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 9200;
const NODE_AGENT_URL = process.env.NODE_AGENT_URL || 'http://node-agent:9100';

const repo = new PrismaRepository();

/** Base URL of the agent owning `nodeId`, falling back to the single-node default (#171). */
async function agentUrlFor(nodeId: string | null): Promise<string> {
  if (!nodeId) return resolveAgentUrl(null, NODE_AGENT_URL);
  const node = (await repo.listNodes()).find((n) => n.id === nodeId);
  return resolveAgentUrl(node, NODE_AGENT_URL);
}

const users = createUserService({ repo });
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
    const r = await agentFetch(`${await agentUrlFor(detail.nodeId)}/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ containerId: detail.containerId }) });
    if (!r.ok) throw new Error('scheduled backup failed');
    const snap = (await r.json()) as { ref: string; sizeBytes: number; path: string };
    await repo.createBackup({ deploymentId: detail.id, name: `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`, path: snap.path, ref: snap.ref, sizeBytes: snap.sizeBytes });
    await repo.appendDeploymentEvent(detail.id, 'schedule-backup', 'snapshot created by schedule');
  },
};

// ── HTTP: API + health probe ──────────────────────────────────────────────────
const app = express();
/**
 * Trust the proxy in front of us for the caller's address (#245).
 *
 * Rate limiting (#225) keys on `req.ip`, and behind a proxy every request appears
 * to come from the proxy — one address carrying everyone's budget, so a handful of
 * failures would lock out the whole installation together.
 *
 * Off by default, and it has to be: `X-Forwarded-For` is an ordinary request
 * header. If the orchestrator is reachable directly, trusting it lets a caller
 * pick which bucket to spend and defeats the limiter entirely. Turn it on only
 * when nothing but the proxy can reach this process.
 */
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') {
  // A number counts hops back from this process; the docs' single reverse proxy
  // is 1. Anything else is passed to Express as-is (an IP, a subnet, 'loopback').
  const value = process.env.TRUST_PROXY.trim();
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
}

app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ service: 'orchestrator', status: 'healthy', ...buildInfo(), uptimeSec: Math.round(process.uptime()) });
});
// Public runtime config (edition flag) — read by the dashboard before login.
app.use(createConfigRouter());
// Public login/registration, then everything below requires a valid Bearer token.
app.use(createAuthRouter({ users, repo }));
// Session-aware (#227): a valid signature is not enough, the session it names
// must still exist — which is what makes signing out actually sign you out.
app.use(createRequireAuth({ repo }));
app.use(createAccountRouter({ users, repo }));
app.use(createUserAdminRouter({ users, repo }));
app.use(createTeamRouter({ repo }));
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

  // Authentication: the JWT rides as a query param (browsers can't set WS
  // headers on the handshake).
  const token = url.searchParams.get('token');
  if (!token) return socket.destroy();
  let principal;
  try {
    principal = verifyToken(token);
  } catch {
    return socket.destroy();
  }

  const detail = await repo.getDeployment(match[1]);
  const target = resolveContainerTarget(detail);
  if (target.status !== 200) return socket.destroy();

  // Authorization: this opens a root shell inside the container, so holding a
  // valid token is not enough — the caller needs console access on *this*
  // server. Every failure closes the socket without saying why.
  const caller = await repo.getUser(principal.id);
  const share = caller ? await repo.getSubuserFor(detail!.id, caller.email) : null;
  const grant = share?.status === 'active' && share.userId === principal.id ? share : null;
  const membership = detail!.teamId ? await repo.getTeamMember(detail!.teamId, principal.id) : null;
  const role = resolveRole({ principal, ownerId: detail!.userId, teamId: detail!.teamId, grant, membership });
  if (!can(role, 'console.connect')) return socket.destroy();

  // Dial the agent that actually owns this deployment (#171).
  const agentUrl = await agentUrlFor(detail!.nodeId);
  const cols = url.searchParams.get('cols') ?? '80';
  const rows = url.searchParams.get('rows') ?? '24';
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    // The agent authorizes this upgrade with the shared internal token (#169) —
    // this hop is server-to-server, so a header is available (unlike the browser's
    // handshake, which carries its JWT as a query param).
    const upstream = new WebSocket(`${toWsUrl(agentUrl)}/terminal/${target.containerId}?cols=${cols}&rows=${rows}`, {
      headers: { [INTERNAL_TOKEN_HEADER]: getInternalToken() },
    });
    upstream.on('open', () => pipeSockets(toDuplex(clientWs), toDuplex(upstream)));
    upstream.on('error', () => clientWs.close());
  });
});

server.listen(PORT, () => console.log(`[Orchestrator] HTTP + WS listening on http://localhost:${PORT}`));

// ── First-run bootstrap ───────────────────────────────────────────────────────
// Make sure there is always exactly one way in on a fresh install, and repair the
// backfilled owner (which has no usable password) on an upgraded one.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

void users
  .bootstrapOwner({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  .then((outcome) => {
    if (outcome !== 'exists') {
      console.log(`[Orchestrator] Administrator account ${outcome === 'created' ? 'created' : 'password set'}: ${ADMIN_EMAIL}`);
    }
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('[Orchestrator] WARNING: administrator password is the built-in default. Set ADMIN_PASSWORD before exposing this panel.');
    }
  })
  .catch((err) => console.error('[Orchestrator] Could not bootstrap the administrator account:', err instanceof Error ? err.message : err));

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
