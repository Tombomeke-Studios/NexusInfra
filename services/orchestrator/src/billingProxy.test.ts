import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createBillingProxyRouter } from './billingProxy.js';

// The proxy forwards to the Billing Bridge with the authenticated userId injected
// into the path. We stub global fetch to stand in for the bridge and stub auth to
// set req.userId.

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { userId?: string }, _res: Response, next: NextFunction) => {
    req.userId = userId;
    next();
  });
  app.use(createBillingProxyRouter());
  return app;
}

describe('billing proxy', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  function upstream(body: unknown, status = 200) {
    return { ok: status < 300, status, text: async () => JSON.stringify(body) } as Response;
  }

  it('forwards GET /billing/wallet with the authenticated userId', async () => {
    fetchMock.mockResolvedValue(upstream({ userId: 'alice', balance: 5, currency: 'EUR' }));
    const res = await request(appAs('alice')).get('/billing/wallet');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'alice', balance: 5, currency: 'EUR' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/billing/alice/wallet');
  });

  it('forwards a top-up POST with its body', async () => {
    fetchMock.mockResolvedValue(upstream({ status: 'pending', reference: 'r1' }, 202));
    const res = await request(appAs('bob')).post('/billing/topup').send({ amount: 20 });
    expect(res.status).toBe(202);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/billing/bob/topup');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ amount: 20 });
  });

  it('returns 502 when the billing service is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const res = await request(appAs('alice')).get('/billing/usage');
    expect(res.status).toBe(502);
  });
});
