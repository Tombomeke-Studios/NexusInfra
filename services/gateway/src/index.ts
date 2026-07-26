import { startHeartbeat } from 'shared';
import { createGatewayApp } from './gateway.js';
import { defaultRoutes } from './routes.js';
import { RateLimiter } from './rateLimit.js';

// ── API Gateway (#20) ─────────────────────────────────────────────────────────
// Single external entry point for client traffic: CORS, per-client rate limiting,
// JWT validation on protected routes, and a reverse proxy to the backend
// (currently the Orchestrator, which itself fronts Billing Bridge + Control Room).
// The WebSocket proxy for the interactive terminal (#69/#71) lands once that WS
// backend exists; the HTTP path is here now.

const PORT = Number(process.env.PORT) || 9400;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://orchestrator:9200';
const RATE_PER_SEC = Number(process.env.RATE_LIMIT_PER_SEC) || 50;
const RATE_BURST = Number(process.env.RATE_LIMIT_BURST) || 100;

const app = createGatewayApp({
  routes: defaultRoutes(ORCHESTRATOR_URL),
  rateLimiter: new RateLimiter({ ratePerSec: RATE_PER_SEC, burst: RATE_BURST }),
});

app.listen(PORT, () => console.log(`[Gateway] Listening on http://localhost:${PORT} → ${ORCHESTRATOR_URL}`));

// Announce liveness on the shared bus so the Control Room sees the gateway too.
try {
  startHeartbeat('gateway', 1000);
  console.log('[Gateway] Publishing heartbeat on monitoring.heartbeat.service.gateway');
} catch (err) {
  console.error('[Gateway] Heartbeat unavailable:', err instanceof Error ? err.message : err);
}

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
