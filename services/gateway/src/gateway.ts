import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { buildInfo, metricsHandler, MetricsRegistry, registerBuildInfo } from 'shared';
import { bearerToken, verifyToken, type VerifiedToken } from './auth.js';
import { matchRoute, type RouteRule } from './routes.js';
import { RateLimiter } from './rateLimit.js';

// The gateway HTTP app: CORS → rate limit → JWT validation (protected routes) →
// reverse-proxy to the matched backend. Built as a factory with injectable seams
// (rate limiter, clock, token verifier) so it's testable with supertest and a
// stubbed fetch — no real backend needed.

export interface GatewayDeps {
  routes: RouteRule[];
  rateLimiter?: RateLimiter;
  now?: () => number;
  verify?: (token: string) => VerifiedToken;
  /** Where to count requests (#246); a fresh registry when not given. */
  metrics?: MetricsRegistry;
  metricsToken?: string;
}

/** Per-client key for rate limiting: the authenticated user if present, else the IP. */
function clientKey(req: Request): string {
  const token = bearerToken(req.headers.authorization);
  if (token) {
    try {
      return `user:${verifyToken(token).userId}`;
    } catch {
      // fall through to IP for unverifiable tokens
    }
  }
  return `ip:${req.ip}`;
}

// Hop-by-hop and host headers we must not forward verbatim.
const STRIP = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

function forwardHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (STRIP.has(k) || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  // Preserve the original client IP for backend logging.
  out['x-forwarded-for'] = req.ip ?? '';
  // The authenticated user id (set after JWT validation) for downstream services.
  const userId = (req as Request & { userId?: string }).userId;
  if (userId) out['x-user-id'] = userId;
  return out;
}

export function createGatewayApp(deps: GatewayDeps): express.Express {
  const { routes } = deps;
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ ratePerSec: 50, burst: 100 });
  const now = deps.now ?? Date.now;
  const verify = deps.verify ?? ((token: string) => verifyToken(token));
  const metrics = deps.metrics ?? new MetricsRegistry();
  if (!deps.metrics) registerBuildInfo(metrics, 'gateway', buildInfo());
  // One series per route *prefix* and outcome — bounded by the routing table, so
  // a flood of made-up paths cannot mint new series (#246).
  const handled = metrics.counter('nexusinfra_gateway_requests_total', 'Requests the gateway handled, by route prefix, outcome and status class.');
  const count = (route: string, outcome: string, status: number) => handled.inc({ route, outcome, status: `${Math.floor(status / 100)}xx` });

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.get('/metrics', metricsHandler(metrics, { token: deps.metricsToken ?? process.env.METRICS_TOKEN }));
  // The gateway's own liveness probe (not proxied).
  app.get('/health', (_req, res) => {
    res.json({ service: 'gateway', status: 'healthy', ...buildInfo(), uptimeSec: Math.round(process.uptime()) });
  });

  // Capture the raw body as a Buffer so it streams through unmodified (any content type).
  app.use(express.raw({ type: () => true, limit: '10mb' }));

  app.all('*', async (req: Request, res: Response) => {
    const route = matchRoute(req.path, routes);
    if (!route) {
      count('none', 'no_route', 404);
      return res.status(404).json({ error: 'no route for path' });
    }

    // Rate limit first so floods are cheap to reject.
    if (!rateLimiter.allow(clientKey(req), now())) {
      count(route.prefix, 'rate_limited', 429);
      return res.status(429).json({ error: 'rate limit exceeded' });
    }

    // JWT validation for protected routes.
    if (!route.public) {
      const token = bearerToken(req.headers.authorization);
      if (!token) {
        count(route.prefix, 'unauthorized', 401);
        return res.status(401).json({ error: 'missing bearer token' });
      }
      try {
        (req as Request & { userId?: string }).userId = verify(token).userId;
      } catch {
        count(route.prefix, 'unauthorized', 401);
        return res.status(401).json({ error: 'invalid or expired token' });
      }
    }

    // Reverse-proxy to the backend, preserving method/path/query and body.
    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    try {
      const upstream = await fetch(`${route.target}${req.originalUrl}`, {
        method: req.method,
        headers: forwardHeaders(req),
        body: hasBody ? req.body : undefined,
      });
      res.status(upstream.status);
      count(route.prefix, 'proxied', upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.set('content-type', contentType);
      const buf = Buffer.from(await upstream.arrayBuffer());
      return buf.length ? res.send(buf) : res.end();
    } catch {
      count(route.prefix, 'upstream_error', 502);
      return res.status(502).json({ error: 'backend unreachable' });
    }
  });

  return app;
}
