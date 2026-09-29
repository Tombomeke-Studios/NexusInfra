import express, { type Request, type Response } from 'express';
import cors from 'cors';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { buildInfo, metricsHandler, MetricsRegistry, registerBuildInfo } from 'shared';
import { bearerToken, isApiToken, verifyToken, type VerifiedToken } from './auth.js';
import { matchRoute, type MatchedRoute, type RouteRule } from './routes.js';
import { RateLimiter } from './rateLimit.js';
import { proxyUpgrade, refuseUpgrade } from './upgrade.js';

// The gateway: CORS → rate limit → token check (protected routes) → reverse
// proxy to the matched backend, for both plain HTTP and WebSocket upgrades.
// Built as a factory with injectable seams (rate limiter, clock, token verifier)
// so it's testable with supertest and a stubbed fetch — no real backend needed.

export interface GatewayDeps {
  routes: RouteRule[];
  rateLimiter?: RateLimiter;
  now?: () => number;
  verify?: (token: string) => VerifiedToken;
  /** Where to count requests (#246); a fresh registry when not given. */
  metrics?: MetricsRegistry;
  metricsToken?: string;
}

// Hop-by-hop and host headers we must not forward verbatim — and `x-user-id`,
// which only the gateway may set: passed through from the caller, it would be an
// identity the caller chose.
const STRIP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-user-id']);

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

// Response headers that describe this hop rather than the body. `fetch` also
// decodes a compressed body on the way in, so a `content-encoding` (and the
// length that went with it) would describe bytes we no longer have.
const RESPONSE_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'set-cookie']);

/** Copy the backend's response headers onto ours, minus the ones that belong to that hop. */
export function copyResponseHeaders(from: Headers, res: Response): void {
  const encoded = from.has('content-encoding');
  from.forEach((value, key) => {
    if (RESPONSE_HOP.has(key)) return;
    if (encoded && (key === 'content-encoding' || key === 'content-length')) return;
    res.setHeader(key, value);
  });
  // Joined with ", " by forEach, which corrupts cookies — they are copied one by one.
  const cookies = from.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader('set-cookie', cookies);
}

/** What the gate decided about one request, for HTTP and upgrades alike. */
export type GateDecision =
  | { ok: true; route: MatchedRoute; userId?: string }
  | { ok: false; route: string; status: number; outcome: string; error: string };

export interface Gateway {
  app: express.Express;
  /** Handler for the HTTP server's `upgrade` event — the WebSocket proxy (#69). */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/** The HTTP app on its own — what most tests and callers without WebSockets need. */
export function createGatewayApp(deps: GatewayDeps): express.Express {
  return createGateway(deps).app;
}

export function createGateway(deps: GatewayDeps): Gateway {
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

  /** Per-client key for rate limiting: the verified user if there is one, else the address. */
  function clientKey(token: string | null, ip: string | undefined): string {
    if (token && !isApiToken(token)) {
      try {
        return `user:${verify(token).userId}`;
      } catch {
        // fall through to the address for unverifiable tokens
      }
    }
    return `ip:${ip}`;
  }

  /**
   * Route, rate-limit and authenticate one request. Shared by HTTP and upgrades,
   * so a WebSocket is not a way around any of the three.
   */
  function gate(path: string, token: string | null, ip: string | undefined): GateDecision {
    const route = matchRoute(path, routes);
    if (!route) return { ok: false, route: 'none', status: 404, outcome: 'no_route', error: 'no route for path' };

    // Rate limit first so floods are cheap to reject.
    if (!rateLimiter.allow(clientKey(token, ip), now())) {
      return { ok: false, route: route.prefix, status: 429, outcome: 'rate_limited', error: 'rate limit exceeded' };
    }

    if (route.public) return { ok: true, route };
    if (!token) return { ok: false, route: route.prefix, status: 401, outcome: 'unauthorized', error: 'missing bearer token' };
    // Opaque to us; the Orchestrator verifies it (#228).
    if (isApiToken(token)) return { ok: true, route };
    try {
      return { ok: true, route, userId: verify(token).userId };
    } catch {
      return { ok: false, route: route.prefix, status: 401, outcome: 'unauthorized', error: 'invalid or expired token' };
    }
  }

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
    const decision = gate(req.path, bearerToken(req.headers.authorization), req.ip);
    if (!decision.ok) {
      count(decision.route, decision.outcome, decision.status);
      return res.status(decision.status).json({ error: decision.error });
    }
    const { route } = decision;
    if (decision.userId) (req as Request & { userId?: string }).userId = decision.userId;

    // A client that goes away must take the backend request with it. Live logs
    // and stats are endless streams: without this, every closed tab left one
    // open at the Orchestrator, and at the node agent behind it.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    // Reverse-proxy to the backend, preserving method/path/query and body.
    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${route.target}${req.originalUrl}`, {
        method: req.method,
        headers: forwardHeaders(req),
        body: hasBody ? req.body : undefined,
        // A redirect is the backend's answer to the client, not an instruction to us.
        redirect: 'manual',
        signal: abort.signal,
      });
    } catch {
      count(route.prefix, 'upstream_error', 502);
      if (abort.signal.aborted) return;
      return res.status(502).json({ error: 'backend unreachable' });
    }

    count(route.prefix, 'proxied', upstream.status);
    res.status(upstream.status);
    copyResponseHeaders(upstream.headers, res);
    if (!upstream.body) return res.end();

    // Streamed, never buffered: a server-sent event has to reach the browser when
    // it happens, not when the stream ends — which, for a log tail, is never. The
    // same goes for a backup download, which used to sit in this process's memory
    // in full before the first byte went out.
    res.flushHeaders();
    const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
    // Past the headers the status is spent; all that is left is to cut the
    // connection so the client sees a truncated body rather than a complete one.
    body.on('error', () => res.destroy());
    body.pipe(res);
  });

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://gateway');
    // A browser cannot set headers on a WebSocket handshake, so the token rides
    // in the query; the header is honoured for everything else.
    const token = url.searchParams.get('token') ?? bearerToken(req.headers.authorization);
    const decision = gate(url.pathname, token, req.socket.remoteAddress);
    if (!decision.ok) {
      count(decision.route, decision.outcome, decision.status);
      return refuseUpgrade(socket, decision.status);
    }
    count(decision.route.prefix, 'upgraded', 101);
    proxyUpgrade(req, socket, head, decision.route.target, {
      'x-forwarded-for': req.socket.remoteAddress ?? '',
      ...(decision.userId ? { 'x-user-id': decision.userId } : {}),
    });
  }

  return { app, upgrade };
}
