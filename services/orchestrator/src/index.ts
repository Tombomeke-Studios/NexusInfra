import express from 'express';
import cors from 'cors';
import { consumeRabbitQueue, startHeartbeat, type EventEnvelope } from 'shared';
import { PrismaRepository } from './db.js';
import { createApiRouter } from './api.js';
import { createAuthRouter, requireAuth } from './auth.js';
import { createNodeRegistry } from './nodeRegistry.js';
import { createLifecycle } from './lifecycle.js';

// ── Orchestrator ────────────────────────────────────────────────────────────
// Turns deployment requests into running containers. It keeps a node registry
// from heartbeats, places deployments on the least-loaded node (api.ts), commands
// the Node Agent over the shared bus, and updates deployment state from the
// agent's lifecycle reports.

const PORT = Number(process.env.PORT) || 9200;

const repo = new PrismaRepository();
const registry = createNodeRegistry(repo);
const lifecycle = createLifecycle(repo);

// ── HTTP: API + health probe ──────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ service: 'orchestrator', status: 'healthy', uptimeSec: Math.round(process.uptime()) });
});
// Public login, then everything below requires a valid Bearer token.
app.use(createAuthRouter());
app.use(requireAuth);
app.use(createApiRouter({ repo }));
app.listen(PORT, () => console.log(`[Orchestrator] HTTP listening on http://localhost:${PORT}`));

// ── Event bus: node heartbeats + server lifecycle reports ─────────────────────
async function start() {
  try {
    await consumeRabbitQueue(
      'nexusinfra.orchestrator',
      ['monitoring.heartbeat.node.#', 'infra.server.started', 'infra.server.stopped', 'infra.server.crashed'],
      async (envelope: EventEnvelope) => {
        if (envelope.event.type === 'heartbeat.node') {
          await registry.handleHeartbeat(envelope);
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
