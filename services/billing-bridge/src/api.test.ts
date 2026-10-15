import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createBillingService } from './service.js';
import { createBillingRouter } from './api.js';
import { DEFAULT_PLAN } from './pricing.js';

function buildApp(published: Array<{ key: string; envelope: EventEnvelope }>) {
  const repo = new InMemoryRepository([{ ...DEFAULT_PLAN, maxServers: 3 }]);
  const service = createBillingService({ repo, publish: async (key, envelope) => { published.push({ key, envelope }); return true; } });
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter({ repo, service }));
  return { app, repo, service };
}

describe('billing API', () => {
  let published: Array<{ key: string; envelope: EventEnvelope }>;
  let app: express.Express;

  beforeEach(() => {
    published = [];
    ({ app } = buildApp(published));
  });

  it('returns a zero wallet for a new user', async () => {
    const res = await request(app).get('/billing/u1/wallet');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1', balance: 0, currency: DEFAULT_PLAN.currency });
  });

  it('starts a top-up and emits payment.request', async () => {
    const res = await request(app).post('/billing/u1/topup').send({ amount: 25, email: 'U1@Example.com' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.payerEmail).toBe('u1@example.com');
    expect(published[0].key).toBe('bank.payment.request');
    expect(readPayload(published[0].envelope.event)).toMatchObject({ amount: 25, customerEmail: 'u1@example.com' });
  });

  it('refuses a top-up that does not say who FinVault should ask (#351)', async () => {
    const res = await request(app).post('/billing/u1/topup').send({ amount: 25 });
    expect(res.status).toBe(400);
    expect(published).toHaveLength(0);
  });

  it('answers 409 once too many top-ups are waiting', async () => {
    for (let i = 0; i < 3; i++) await request(app).post('/billing/u1/topup').send({ amount: 5, email: 'u1@example.com' });
    const res = await request(app).post('/billing/u1/topup').send({ amount: 5, email: 'u1@example.com' });
    expect(res.status).toBe(409);
    expect(published).toHaveLength(3);
  });

  it('rejects a non-positive top-up', async () => {
    const res = await request(app).post('/billing/u1/topup').send({ amount: 0, email: 'u1@example.com' });
    expect(res.status).toBe(400);
  });

  it('reports an account’s standing (#365)', async () => {
    const res = await request(app).get('/billing/u1/standing');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ balance: 0, accrued: 0, available: 0, canRun: expect.any(Boolean), currency: DEFAULT_PLAN.currency });
  });

  it('serves the plan catalogue and lets a plan be added and edited (#369)', async () => {
    const created = await request(app).post('/plans').send({ name: 'Pro', pricePerHour: 0.05, maxServers: 10, maxDatabases: 10 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'pro', active: true });
    expect((await request(app).post('/plans').send({ name: 'Pro', pricePerHour: 0.05, maxServers: 10, maxDatabases: 10 })).status).toBe(409);
    expect((await request(app).put('/plans/pro').send({ pricePerHour: 0.08 })).body.pricePerHour).toBe(0.08);
    expect((await request(app).put('/plans/nope').send({})).status).toBe(404);
    expect((await request(app).get('/plans')).body.map((p: { id: string }) => p.id).sort()).toEqual(['pro', DEFAULT_PLAN.id].sort());
  });

  it('moves an account to another plan, and adjusts its credit (#369)', async () => {
    await request(app).post('/plans').send({ name: 'Pro', pricePerHour: 0.05, maxServers: 10, maxDatabases: 10 });
    expect((await request(app).put('/billing/u1/plan').send({ planId: 'pro' })).status).toBe(200);
    expect((await request(app).get('/billing/u1/plan')).body.id).toBe('pro');
    expect((await request(app).put('/billing/u1/plan').send({})).status).toBe(400);

    const adjusted = await request(app).post('/billing/u1/adjust').send({ amount: 12, reason: 'refund', by: 'admin@host.example' });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.wallet.balance).toBe(12);
    expect((await request(app).post('/billing/u1/adjust').send({ amount: 12 })).status).toBe(400);
    expect((await request(app).get('/accounts')).body).toEqual([expect.objectContaining({ userId: 'u1', planId: 'pro', balance: 12 })]);
  });

  it('answers a server quota check', async () => {
    const ok = await request(app).get('/billing/u1/quota?resource=servers&current=2');
    expect(ok.body).toEqual({ allowed: true, limit: 3 });
    const over = await request(app).get('/billing/u1/quota?resource=servers&current=3');
    expect(over.body).toEqual({ allowed: false, limit: 3 });
  });

  // #297: what the plan allows, and how it charges, stated from the same
  // constants the charge is computed with.
  it('states the plan entitlements and the charging model', async () => {
    const res = await request(app).get('/billing/u1/entitlements');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      planId: 'standard',
      planName: 'Standard',
      maxServers: 3,
      maxDatabases: 5,
      maxRamMb: 8192,
      maxBackupsPerServer: 10,
      charging: {
        basis: 'runtime-hours',
        pricePerHour: 0.02,
        currency: 'EUR',
        freeHoursPerMonth: 100,
        sizeFactor: { standardCpuPercent: 50, standardRamPercent: 50, minimum: 0.25 },
      },
    });
  });

  it('reports no ceiling as null rather than inventing one', async () => {
    const repo = new InMemoryRepository([{ ...DEFAULT_PLAN, maxRamMb: null, maxBackupsPerServer: null }]);
    const service = createBillingService({ repo, publish: async () => true });
    const open = express().use(createBillingRouter({ repo, service }));
    const res = await request(open).get('/billing/u1/entitlements');
    expect(res.body.maxRamMb).toBeNull();
    expect(res.body.maxBackupsPerServer).toBeNull();
  });

  it('validates the quota resource', async () => {
    const res = await request(app).get('/billing/u1/quota?resource=bogus&current=0');
    expect(res.status).toBe(400);
  });
});
