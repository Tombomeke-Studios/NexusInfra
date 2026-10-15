import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { INTERNAL_TOKEN_HEADER } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createBillingPlansRouter, planFitProblem, type Plan } from './billingPlans.js';

// The Billing Bridge is stubbed at `fetch`; the accounts and servers are real
// (in memory), since deciding who may ask and what fits is this router's job.

const STANDARD: Plan = { id: 'standard', name: 'Standard', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, maxServers: 5, maxDatabases: 5, maxRamMb: 8192, maxBackupsPerServer: 10, active: true };
const SMALL: Plan = { ...STANDARD, id: 'small', name: 'Small', maxServers: 1, maxRamMb: 2048 };
const RETIRED: Plan = { ...STANDARD, id: 'legacy', name: 'Legacy', active: false };

const USAGE = { servers: 0, databases: 0, ramMb: 0, uncappedServers: 0 };

describe('planFitProblem (#369)', () => {
  it('lets an account that fits move', () => {
    expect(planFitProblem(SMALL, { ...USAGE, servers: 1, ramMb: 2048 })).toBeNull();
  });

  it('says what has to go before a smaller plan fits', () => {
    expect(planFitProblem(SMALL, { ...USAGE, servers: 3 })).toMatch(/you have 3 servers and the Small plan allows 1 — delete 2 servers first/);
    expect(planFitProblem({ ...SMALL, maxServers: 5, maxDatabases: 0 }, { ...USAGE, databases: 1 })).toMatch(/1 database .* delete 1 database first/);
    expect(planFitProblem(SMALL, { ...USAGE, servers: 1, ramMb: 4096 })).toMatch(/hold 4 GB .* includes 2 GB .* by 2 GB first/);
  });

  it('wants every server capped before moving under a memory ceiling', () => {
    expect(planFitProblem(SMALL, { ...USAGE, servers: 1, uncappedServers: 1 })).toMatch(/no memory limit/);
    expect(planFitProblem({ ...SMALL, maxRamMb: null }, { ...USAGE, servers: 1, uncappedServers: 1 })).toBeNull();
  });
});

describe('plans and the provider’s view (#369)', () => {
  const CUSTOMER = { id: 'u-cust', platformRole: 'user' as const };
  const ADMIN = { id: 'u-admin', platformRole: 'admin' as const };
  let repo: InMemoryRepository;
  let currentPlan: Plan;
  const fetchMock = vi.fn();

  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function appAs(principal: { id: string; platformRole: 'user' | 'admin' | 'owner' }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { principal?: unknown }).principal = principal;
      next();
    });
    app.use(createBillingPlansRouter({ repo }));
    return app;
  }

  const callsTo = (suffix: string, method = 'GET') =>
    fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && ((init as RequestInit | undefined)?.method ?? 'GET') === method);

  beforeEach(async () => {
    repo = new InMemoryRepository();
    await repo.createUser({ id: CUSTOMER.id, email: 'cust@example.com', displayName: 'Cust', passwordHash: '!', platformRole: 'user' });
    await repo.createUser({ id: ADMIN.id, email: 'admin@host.example', displayName: 'Admin', passwordHash: '!', platformRole: 'admin' });
    currentPlan = STANDARD;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';
      if (path === '/plans' && method === 'GET') return reply([STANDARD, SMALL, RETIRED]);
      if (path === '/plans' && method === 'POST') return reply({ ...SMALL, id: 'new' }, 201);
      if (path.startsWith('/plans/') && method === 'PUT') return reply(SMALL);
      if (path.endsWith('/plan') && method === 'GET') return reply(currentPlan);
      if (path.endsWith('/plan') && method === 'PUT') return reply(SMALL);
      if (path === '/accounts') return reply([{ userId: CUSTOMER.id, planId: 'small', planName: 'Small', balance: 12, available: 9, canRun: true, currency: 'EUR', hours: 3, cost: 3, runningServers: 1 }]);
      if (path.endsWith('/adjust')) return reply({ wallet: { balance: 20 } });
      return reply({ error: 'unexpected' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function giveServers(n: number) {
    for (let i = 0; i < n; i++) {
      const config = await repo.createServerConfig({ userId: CUSTOMER.id, name: `s${i}`, dockerImage: 'nginx' });
      await repo.createDeployment(config.id, null);
    }
  }

  it('shows a customer the plans on offer and which one is theirs', async () => {
    const res = await request(appAs(CUSTOMER)).get('/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.currentPlanId).toBe('standard');
    expect(res.body.plans.map((p: Plan) => p.id)).toEqual(['standard', 'small']);
  });

  it('still shows a customer the retired plan they are on', async () => {
    currentPlan = RETIRED;
    const res = await request(appAs(CUSTOMER)).get('/billing/plans');
    expect(res.body.plans.map((p: Plan) => p.id)).toEqual(['standard', 'small', 'legacy']);
  });

  it('moves a customer to a plan they fit, for their own account only', async () => {
    const res = await request(appAs(CUSTOMER)).put('/billing/plan').send({ planId: 'small', userId: 'someone-else' });
    expect(res.status).toBe(200);
    const [call] = callsTo(`/billing/${CUSTOMER.id}/plan`, 'PUT');
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ planId: 'small' });
    expect((call[1] as RequestInit).headers).toHaveProperty(INTERNAL_TOKEN_HEADER);
  });

  it('refuses a plan the customer’s servers do not fit, and says so on the list', async () => {
    await giveServers(2);
    const res = await request(appAs(CUSTOMER)).put('/billing/plan').send({ planId: 'small' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 servers and the Small plan allows 1/);
    expect(callsTo('/plan', 'PUT')).toEqual([]);

    const listed = await request(appAs(CUSTOMER)).get('/billing/plans');
    expect(listed.body.plans.find((p: Plan) => p.id === 'small').problem).toMatch(/delete 1 server first/);
    expect(listed.body.plans.find((p: Plan) => p.id === 'standard').problem).toBeNull();
  });

  it('answers 404 for a plan that does not exist', async () => {
    expect((await request(appAs(CUSTOMER)).put('/billing/plan').send({ planId: 'nope' })).status).toBe(404);
  });

  it('keeps the provider’s routes for platform administrators', async () => {
    const app = appAs(CUSTOMER);
    expect((await request(app).get('/billing/admin/plans')).status).toBe(403);
    expect((await request(app).post('/billing/admin/plans').send({})).status).toBe(403);
    expect((await request(app).put('/billing/admin/plans/small').send({})).status).toBe(403);
    expect((await request(app).get('/billing/admin/accounts')).status).toBe(403);
    expect((await request(app).put(`/billing/admin/accounts/${CUSTOMER.id}/plan`).send({ planId: 'small' })).status).toBe(403);
    expect((await request(app).post(`/billing/admin/accounts/${CUSTOMER.id}/credit`).send({ amount: 50, reason: 'x' })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets an administrator manage the catalogue, retired plans included', async () => {
    const app = appAs(ADMIN);
    expect((await request(app).get('/billing/admin/plans')).body.map((p: Plan) => p.id)).toEqual(['standard', 'small', 'legacy']);
    expect((await request(app).post('/billing/admin/plans').send({ name: 'New' })).status).toBe(201);
    expect((await request(app).put('/billing/admin/plans/small').send({ pricePerHour: 1 })).status).toBe(200);
  });

  it('lists every account in the panel, whether or not billing has heard of it', async () => {
    await giveServers(1);
    const res = await request(appAs(ADMIN)).get('/billing/admin/accounts');
    expect(res.status).toBe(200);
    expect(res.body.find((a: { userId: string }) => a.userId === CUSTOMER.id)).toMatchObject({ email: 'cust@example.com', planName: 'Small', balance: 12, available: 9, servers: 1, runningServers: 1 });
    // The administrator has no billing activity: on the page anyway, on the default plan.
    expect(res.body.find((a: { userId: string }) => a.userId === ADMIN.id)).toMatchObject({ email: 'admin@host.example', planId: 'standard', balance: 0, canRun: null });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('records who adjusted an account’s credit, from the session and not the request', async () => {
    const res = await request(appAs(ADMIN)).post(`/billing/admin/accounts/${CUSTOMER.id}/credit`).send({ amount: 20, reason: 'refund', by: 'somebody@else.example' });
    expect(res.status).toBe(200);
    const [call] = callsTo(`/billing/${CUSTOMER.id}/adjust`, 'POST');
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ amount: 20, reason: 'refund', by: 'admin@host.example' });
  });

  it('answers 404 for an account that does not exist, without asking billing', async () => {
    expect((await request(appAs(ADMIN)).post('/billing/admin/accounts/ghost/credit').send({ amount: 5, reason: 'x' })).status).toBe(404);
    expect((await request(appAs(ADMIN)).put('/billing/admin/accounts/ghost/plan').send({ planId: 'small' })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says billing is unreachable rather than failing', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect((await request(appAs(CUSTOMER)).get('/billing/plans')).status).toBe(502);
    expect((await request(appAs(ADMIN)).get('/billing/admin/accounts')).status).toBe(502);
  });
});
