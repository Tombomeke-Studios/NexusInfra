import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createBillingProxyRouter, payerChoice, type BillingProxyDeps } from './billingProxy.js';

// The proxy forwards to the Billing Bridge with the authenticated userId injected
// into the path. We stub global fetch to stand in for the bridge and stub auth to
// set req.userId.

const EMAILS: Record<string, string> = { alice: 'alice@example.com', bob: 'bob@example.com' };

function appAs(userId: string | undefined, deps: Partial<BillingProxyDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { userId?: string }, _res: Response, next: NextFunction) => {
    req.userId = userId;
    next();
  });
  app.use(createBillingProxyRouter({ emailOf: async (id) => EMAILS[id] ?? null, canScan: true, ...deps }));
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
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ amount: 20, account: 'bob@example.com', email: 'bob@example.com' });
  });

  const sent = () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

  it('sends the request to the FinVault address the customer named, saying whose credit it is (#445)', async () => {
    fetchMock.mockResolvedValue(upstream({ status: 'pending', reference: 'r1' }, 202));
    await request(appAs('bob')).post('/billing/topup').send({ amount: 20, finvaultEmail: ' Bob.Bank@Example.com ' });
    expect(sent()).toEqual({ amount: 20, account: 'bob@example.com', email: 'bob.bank@example.com' });
  });

  it('ignores the old `email` field: only finvaultEmail names a payer', async () => {
    fetchMock.mockResolvedValue(upstream({ status: 'pending', reference: 'r1' }, 202));
    await request(appAs('bob')).post('/billing/topup').send({ amount: 20, email: 'victim@example.com' });
    expect(sent().email).toBe('bob@example.com');
  });

  it('starts a scan-only top-up that sends no address at all (#445)', async () => {
    fetchMock.mockResolvedValue(upstream({ status: 'pending', reference: 'r1' }, 202));
    await request(appAs('bob')).post('/billing/topup').send({ amount: 20, payWith: 'qr', finvaultEmail: 'x@example.com' });
    expect(sent()).toEqual({ amount: 20, account: 'bob@example.com' });
  });

  it('does not hold a scan-only top-up to the email confirmation, which guards an address it never sends', async () => {
    fetchMock.mockResolvedValue(upstream({ status: 'pending', reference: 'r1' }, 202));
    const app = appAs('bob', { topUpProblem: async () => 'confirm your email address first' });
    expect((await request(app).post('/billing/topup').send({ amount: 20, payWith: 'qr' })).status).toBe(202);
    expect((await request(app).post('/billing/topup').send({ amount: 20, finvaultEmail: 'b@example.com' })).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a scan-only top-up where there is no QR to scan', async () => {
    const res = await request(appAs('bob', { canScan: false })).post('/billing/topup').send({ amount: 20, payWith: 'qr' });
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an address that is not one, without calling the bridge', async () => {
    const res = await request(appAs('bob')).post('/billing/topup').send({ amount: 20, finvaultEmail: 'not an address' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a top-up for an account with no address, without calling the bridge', async () => {
    const res = await request(appAs('nobody')).post('/billing/topup').send({ amount: 20 });
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 rather than acting for a shared stand-in account', async () => {
    const res = await request(appAs(undefined)).get('/billing/wallet');
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 502 when the billing service is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const res = await request(appAs('alice')).get('/billing/usage');
    expect(res.status).toBe(502);
  });
});

describe('payerChoice (#445)', () => {
  it('falls back to the account address when none is named', () => {
    expect(payerChoice({}, 'a@x.io')).toEqual({ scanOnly: false, email: 'a@x.io' });
    expect(payerChoice({ payWith: 'email', finvaultEmail: '' }, 'a@x.io')).toEqual({ scanOnly: false, email: 'a@x.io' });
  });

  it('refuses a way of paying it does not know', () => {
    expect(payerChoice({ payWith: 'card' }, 'a@x.io')).toHaveProperty('problem');
  });
});
