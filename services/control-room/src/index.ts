import express from 'express';
import {
  buildInfo,
  consumeRabbitQueue,
  startHeartbeat,
  readPayload,
  type EventEnvelope,
} from 'shared';
import { DEGRADED_MS, Monitor, OFFLINE_MS } from './monitor.js';

// ── Control Room ──────────────────────────────────────────────────────────────
// Connects to the shared `finvault.events` bus, emits its own heartbeat, and
// monitors every service/node heartbeat. Status thresholds follow
// CONCEPTS/infrastructure-platform/architecture.md: healthy → degraded (3s) →
// offline (10s). The tracking/uptime maths live in monitor.ts (pure + tested);
// this file is wiring. State is in-memory — persisted history is a later phase.

const PORT = Number(process.env.PORT) || 9000;

const monitor = new Monitor();

// ── HTTP: health + live status view ───────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => {
  res.json({ service: 'control-room', status: 'healthy', ...buildInfo(), uptimeSec: Math.round(process.uptime()) });
});

// Live snapshot: one entry per heartbeat source with its derived status and
// uptime %. Shape is backward-compatible — `uptimePercent` was added (#165).
app.get('/status', (_req, res) => {
  res.json({ monitored: monitor.snapshot(Date.now()), thresholds: { degradedMs: DEGRADED_MS, offlineMs: OFFLINE_MS } });
});

// Reliability detail: cumulative uptime plus recent status transitions per source.
app.get('/uptime', (_req, res) => {
  res.json({ sources: monitor.uptimes(Date.now()), thresholds: { degradedMs: DEGRADED_MS, offlineMs: OFFLINE_MS } });
});

app.listen(PORT, () => console.log(`[Control Room] HTTP listening on http://localhost:${PORT}`));

// ── Event bus: consume heartbeats, emit our own ───────────────────────────────
async function start() {
  try {
    await consumeRabbitQueue(
      'nexusinfra.control-room',
      ['monitoring.heartbeat.#'],
      async (envelope: EventEnvelope) => {
        // Payload may be encrypted; readPayload transparently decrypts when a key is set.
        let source = envelope.source;
        try {
          const payload = readPayload(envelope.event) as { name?: string; nodeId?: string };
          source = payload.name || payload.nodeId || envelope.source;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[Control Room] Could not read heartbeat payload from ${envelope.source}: ${message}`);
        }
        monitor.heartbeat(source, Date.now());
      }
    );

    // Emit our own heartbeat so the Control Room appears in its own status view.
    startHeartbeat('control-room', 1000);
    console.log('[Control Room] Monitoring heartbeats on monitoring.heartbeat.#');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Control Room] Failed to connect to event bus:', message);
    console.error('[Control Room] HTTP endpoints remain available; set RABBITMQ_URL to enable monitoring.');
  }
}

void start();

// Advance the monitor's clock so status changes are recorded promptly (and uptime
// is attributed as it accrues), logging anything that isn't healthy.
setInterval(() => {
  const now = Date.now();
  monitor.evaluate(now);
  for (const s of monitor.snapshot(now)) {
    if (s.status !== 'healthy') {
      console.warn(`[Control Room] ${s.source} is ${s.status} (last seen ${s.lastSeenMsAgo}ms ago, uptime ${s.uptimePercent}%)`);
    }
  }
}, DEGRADED_MS);

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
