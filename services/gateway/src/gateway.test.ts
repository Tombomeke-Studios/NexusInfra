import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createGatewayApp } from './gateway.js';
import { defaultRoutes } from './routes.js';
import { RateLimiter } from './rateLimit.js';

const TARGET = 'http://orchestrator:9200';
const SECRET = 'test-secret';
const routes = defaultRoutes(TARGET);
// Signed once, deliberately. jwt.sign stamps `iat` with second granularity,
// so signing separately for the request and for the assertion produces two
// different strings whenever the calls straddle a second boundary — which is
// exactly the intermittent failure this used to cause (#208).
const TOKEN = jwt.sign({ sub: 'user-1' }, SECRET);
const token = () => TOKEN;

function upstream(body: unknown, status = 200) {
  return {
    status,
    headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  } as unknown as Response;
}

describe('gateway app', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(upstream({ ok: true }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function app(opts?: { rateLimiter?: RateLimiter }) {
    return createGatewayApp({ routes, rateLimiter: opts?.rateLimiter, verify: (t) => ({ userId: (jwt.verify(t, SECRET) as { sub: string }).sub }) });
  }

  it('proxies a public route without a token', async () => {
    const res = await request(app()).get('/config');
    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TARGET}/config`);
  });

  it('rejects a protected route without a token (401)', async () => {
    const res = await request(app()).get('/deployments');
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies a protected route with a valid token, forwarding it', async () => {
    const res = await request(app()).get('/deployments').set('authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TARGET}/deployments`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${token()}` });
  });

  it('forwards the request body on POST', async () => {
    fetchMock.mockResolvedValue(upstream({ id: 'd1' }, 201));
    const res = await request(app()).post('/deployments').set('authorization', `Bearer ${token()}`).send({ name: 'svc', dockerImage: 'nginx' });
    expect(res.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'svc', dockerImage: 'nginx' });
  });

  it('returns 404 for an unrouted path', async () => {
    const res = await request(app()).get('/nope');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rate-limits floods with 429', async () => {
    const rl = new RateLimiter({ ratePerSec: 0, burst: 1 });
    const a = app({ rateLimiter: rl });
    expect((await request(a).get('/config')).status).toBe(200);
    expect((await request(a).get('/config')).status).toBe(429);
  });

  it('returns 502 when the backend is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app()).get('/config');
    expect(res.status).toBe(502);
  });
});
