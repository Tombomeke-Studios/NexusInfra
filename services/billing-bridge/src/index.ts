import express from 'express';
import cors from 'cors';
import { consumeRabbitQueue, getEdition, isHosted, readPayload, startHeartbeat, type EventEnvelope } from 'shared';
import { PrismaRepository } from './db.js';
import { createBillingService } from './service.js';
import { createBillingRouter } from './api.js';

// ── Billing Bridge (hosted edition) ───────────────────────────────────────────
// Turns bus events into runtime intervals and credit movements, drives the
// top-up flow to FinVault, and serves the dashboard's Billing page + the
// Orchestrator's quota checks. In the community edition this service is inert:
// it exposes /health so compose stays green but runs no billing.

const PORT = Number(process.env.PORT) || 9300;
const edition = getEdition();

const repo = new PrismaRepository();
const service = createBillingService({ repo });

const app = express();
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ service: 'billing-bridge', status: 'healthy', edition, uptimeSec: Math.round(process.uptime()) });
});

if (isHosted(edition)) {
  app.use(createBillingRouter({ repo, service }));
}
app.listen(PORT, () => console.log(`[BillingBridge] HTTP listening on http://localhost:${PORT} (edition: ${edition})`));

// ── Event bus ─────────────────────────────────────────────────────────────────
async function start() {
  if (!isHosted(edition)) {
    console.log('[BillingBridge] Community edition — billing disabled; not consuming events.');
    return;
  }
  try {
    await repo.ensureDefaultPlan();
    await consumeRabbitQueue(
      'nexusinfra.billing-bridge',
      ['infra.deployment.created', 'infra.server.started', 'infra.server.stopped', 'infra.server.crashed', 'bank.payment.confirmed', 'bank.payment.failed'],
      async (envelope: EventEnvelope) => {
        const { type } = envelope.event;
        const payload = readPayload(envelope.event);
        switch (type) {
          case 'deployment.created':
            await service.handleDeploymentCreated(payload as { deploymentId: string; userId: string });
            break;
          case 'server.started':
            await service.handleServerStarted(payload as { deploymentId: string });
            break;
          case 'server.stopped':
          case 'server.crashed':
            await service.handleServerStopped(payload as { deploymentId: string });
            break;
          case 'payment.confirmed':
            await service.handlePaymentConfirmed(payload as { reference: string; amount: number });
            break;
          case 'payment.failed':
            await service.handlePaymentFailed(payload as { reference: string });
            break;
          default:
            break;
        }
      }
    );
    console.log('[BillingBridge] Consuming deployment/runtime + payment events');

    startHeartbeat('billing-bridge', 1000);
    console.log('[BillingBridge] Publishing heartbeat on monitoring.heartbeat.service.billing-bridge');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[BillingBridge] Failed to connect to event bus:', message);
    console.error('[BillingBridge] HTTP API remains available; set RABBITMQ_URL to enable billing.');
  }
}

void start();

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
