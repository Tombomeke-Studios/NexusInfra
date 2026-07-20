import express from 'express';
import {
  consumeRabbitQueue,
  startHeartbeat,
  readPayload,
  type EventEnvelope,
} from 'shared';

// ── Control Room ──────────────────────────────────────────────────────────────
// Phase 1 foundation: connects to the shared `finvault.events` bus, emits its own
// heartbeat, and monitors every service/node heartbeat. Status thresholds follow
// CONCEPTS/infrastructure-platform/architecture.md: healthy → degraded (3s) →
// offline (10s). State is in-memory for the foundation step.

const PORT = Number(process.env.PORT) || 9000;
const DEGRADED_MS = 3000;
const OFFLINE_MS = 10000;

type Status = 'healthy' | 'degraded' | 'offline';

interface Tracked {
  source: string;
  lastSeen: number; // epoch ms
}

const seen = new Map<string, Tracked>();

function statusFor(lastSeen: number, now: number): Status {
  const age = now - lastSeen;
  if (age >= OFFLINE_MS) return 'offline';
  if (age >= DEGRADED_MS) return 'degraded';
  return 'healthy';
}

function snapshot() {
  const now = Date.now();
  return Array.from(seen.values())
    .map((t) => ({ source: t.source, status: statusFor(t.lastSeen, now), lastSeenMsAgo: now - t.lastSeen }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

// ── HTTP: health + live status view ───────────────────────────────────────────
const app = express();

app.get('/health', (_req, res) => {
  res.json({ service: 'control-room', status: 'healthy', uptimeSec: Math.round(process.uptime()) });
});

app.get('/status', (_req, res) => {
  res.json({ monitored: snapshot(), thresholds: { degradedMs: DEGRADED_MS, offlineMs: OFFLINE_MS } });
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
        } catch (err: any) {
          console.warn(`[Control Room] Could not read heartbeat payload from ${envelope.source}: ${err.message}`);
        }
        seen.set(source, { source, lastSeen: Date.now() });
      }
    );

    // Emit our own heartbeat so the Control Room appears in its own status view.
    startHeartbeat('control-room', 1000);
    console.log('[Control Room] Monitoring heartbeats on monitoring.heartbeat.#');
  } catch (err: any) {
    console.error('[Control Room] Failed to connect to event bus:', err.message);
    console.error('[Control Room] HTTP endpoints remain available; set RABBITMQ_URL to enable monitoring.');
  }
}

void start();

// Periodically log any source that has crossed into degraded/offline.
setInterval(() => {
  const now = Date.now();
  for (const t of seen.values()) {
    const status = statusFor(t.lastSeen, now);
    if (status !== 'healthy') {
      console.warn(`[Control Room] ${t.source} is ${status} (last seen ${now - t.lastSeen}ms ago)`);
    }
  }
}, DEGRADED_MS);

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
