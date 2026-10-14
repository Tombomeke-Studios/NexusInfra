import { describe, it, expect, beforeEach } from 'vitest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createBillingService, MAX_PENDING_TOPUPS, type BillingService } from './service.js';
import { DEFAULT_PLAN } from './pricing.js';

// Service tests run against the in-memory repo with a captured publisher and a
// fixed clock — no broker, no DB, no time flakiness.

describe('billing service', () => {
  let repo: InMemoryRepository;
  let published: Array<{ key: string; envelope: EventEnvelope }>;
  let svc: BillingService;
  let clock: string;

  beforeEach(() => {
    repo = new InMemoryRepository([{ ...DEFAULT_PLAN, freeHoursPerMonth: 0, pricePerHour: 1 }]);
    published = [];
    clock = '2026-07-01T00:00:00.000Z';
    svc = createBillingService({
      repo,
      publish: async (key, envelope) => {
        published.push({ key, envelope });
        return true;
      },
      now: () => clock,
      billingWalletId: 'nexus-wallet',
    });
  });

  it('opens an interval on start and closes it on stop', async () => {
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 50, ramPercent: 50 } });
    clock = '2026-07-01T00:00:00.000Z';
    await svc.handleServerStarted({ deploymentId: 'd1' });
    clock = '2026-07-01T02:00:00.000Z';
    const closed = await svc.handleServerStopped({ deploymentId: 'd1' });
    expect(closed?.stoppedAt).toBe('2026-07-01T02:00:00.000Z');

    clock = '2026-07-01T02:00:00.000Z';
    const usage = await svc.getUsage('u1');
    // 2h × €1 × factor 1.0, no free hours → €2.00
    expect(usage.hours).toBe(2);
    expect(usage.cost).toBe(2);
  });

  // #364: what a server costs used to live in a map that a restart emptied.
  it('still bills a server started after the service restarted', async () => {
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 100, ramPercent: 100 } });
    const restarted = createBillingService({ repo, publish: async () => true, now: () => clock });
    const opened = await restarted.handleServerStarted({ deploymentId: 'd1' });
    expect(opened).toMatchObject({ userId: 'u1', limits: { cpuPercent: 100, ramPercent: 100 } });
  });

  it('recognises a server from before #364 by its last interval', async () => {
    await repo.openInterval({ userId: 'u9', deploymentId: 'old', planId: DEFAULT_PLAN.id, limits: { cpuPercent: 50, ramPercent: 50 }, startedAt: '2026-06-01T00:00:00.000Z' });
    await repo.closeInterval('old', '2026-06-01T01:00:00.000Z');
    expect(await svc.handleServerStarted({ deploymentId: 'old' })).toMatchObject({ userId: 'u9', stoppedAt: null });
  });

  it('opens one interval when a start is reported twice', async () => {
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1' });
    const first = await svc.handleServerStarted({ deploymentId: 'd1' });
    const second = await svc.handleServerStarted({ deploymentId: 'd1' });
    expect(second?.id).toBe(first?.id);
    await svc.handleServerStopped({ deploymentId: 'd1' });
    expect((await repo.listIntervals('u1')).filter((i) => i.stoppedAt === null)).toEqual([]);
  });

  it('charges a resized server at its new size from the next start', async () => {
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 50, ramPercent: 50 } });
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 100, ramPercent: 100 } });
    expect((await svc.handleServerStarted({ deploymentId: 'd1' }))?.limits).toEqual({ cpuPercent: 100, ramPercent: 100 });
  });

  it('skips billing for an unknown deployment (no deployment.created seen)', async () => {
    const opened = await svc.handleServerStarted({ deploymentId: 'ghost' });
    expect(opened).toBeNull();
  });

  it('charges the resource factor per interval', async () => {
    await svc.handleDeploymentCreated({ deploymentId: 'd2', userId: 'u2', resourceLimits: { cpuPercent: 100, ramPercent: 100 } });
    clock = '2026-07-01T00:00:00.000Z';
    await svc.handleServerStarted({ deploymentId: 'd2' });
    clock = '2026-07-01T01:00:00.000Z';
    await svc.handleServerStopped({ deploymentId: 'd2' });
    clock = '2026-07-01T01:00:00.000Z';
    const usage = await svc.getUsage('u2');
    // 1h × €1 × factor 2.0 → €2.00
    expect(usage.cost).toBe(2);
  });

  // #366: this used to sum every interval the account ever had.
  it('reports this cycle’s usage, not everything a server ever ran', async () => {
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 50, ramPercent: 50 } });
    clock = '2026-06-10T00:00:00.000Z';
    await svc.handleServerStarted({ deploymentId: 'd1' });
    clock = '2026-06-10T10:00:00.000Z';
    await svc.handleServerStopped({ deploymentId: 'd1' });
    clock = '2026-07-05T00:00:00.000Z';
    await svc.handleServerStarted({ deploymentId: 'd1' });
    clock = '2026-07-05T03:00:00.000Z';
    expect(await svc.getUsage('u1')).toMatchObject({ hours: 3, cost: 3 });
  });

  describe('prepaid credit (#365)', () => {
    const run = async (deploymentId: string, userId: string) => {
      await svc.handleDeploymentCreated({ deploymentId, userId, resourceLimits: { cpuPercent: 50, ramPercent: 50 } });
      await svc.handleServerStarted({ deploymentId });
    };

    it('says an account with no credit may not run, and one with credit may', async () => {
      expect((await svc.getStanding('u1')).canRun).toBe(false);
      await repo.setBalance('u1', 5);
      expect(await svc.getStanding('u1')).toMatchObject({ balance: 5, available: 5, canRun: true });
    });

    it('suspends an account’s servers once its usage reaches its balance', async () => {
      await repo.setBalance('u1', 2);
      await run('d1', 'u1');
      clock = '2026-07-01T01:00:00.000Z';
      expect(await svc.settle()).toEqual([]);

      clock = '2026-07-01T02:00:00.000Z';
      expect(await svc.settle()).toEqual([{ userId: 'u1', deploymentIds: ['d1'] }]);
      const suspend = published.find((p) => p.key === 'billing.server.suspend');
      expect(readPayload(suspend!.envelope.event)).toMatchObject({ userId: 'u1', deploymentIds: ['d1'], reason: 'credit exhausted' });
    });

    it('leaves accounts with credit, and accounts with nothing running, alone', async () => {
      await repo.setBalance('u1', 100);
      await run('d1', 'u1');
      await repo.setBalance('u2', -5); // owes, but runs nothing
      clock = '2026-07-01T05:00:00.000Z';
      expect(await svc.settle()).toEqual([]);
      expect(published.filter((p) => p.key === 'billing.server.suspend')).toEqual([]);
    });

    it('has nothing left to suspend once the servers have stopped', async () => {
      await run('d1', 'u1');
      clock = '2026-07-01T02:00:00.000Z';
      expect(await svc.settle()).toHaveLength(1);
      await svc.handleServerStopped({ deploymentId: 'd1' });
      expect(await svc.settle()).toEqual([]);
    });
  });

  describe('plans (#369)', () => {
    const PRO = { name: 'Pro', pricePerHour: 3, freeHoursPerMonth: 0, maxServers: 10, maxDatabases: 10, maxRamMb: null, maxBackupsPerServer: null };

    it('adds a plan to the catalogue under an id made from its name', async () => {
      const plan = await svc.createPlan({ ...PRO, name: 'Pro Plus' });
      expect(plan).toMatchObject({ id: 'pro-plus', name: 'Pro Plus', active: true, currency: DEFAULT_PLAN.currency });
      await expect(svc.createPlan({ ...PRO, name: 'pro plus' })).rejects.toMatchObject({ status: 409 });
      await expect(svc.createPlan({ ...PRO, pricePerHour: -1 })).rejects.toMatchObject({ status: 400 });
    });

    it('edits a plan, and refuses to retire the one new accounts start on', async () => {
      await svc.createPlan(PRO);
      expect(await svc.updatePlan('pro', { pricePerHour: 4 })).toMatchObject({ name: 'Pro', pricePerHour: 4, maxServers: 10 });
      expect(await svc.updatePlan('pro', { active: false })).toMatchObject({ active: false });
      await expect(svc.updatePlan(DEFAULT_PLAN.id, { active: false })).rejects.toMatchObject({ status: 409 });
      await expect(svc.updatePlan('nope', { pricePerHour: 1 })).rejects.toMatchObject({ status: 404 });
    });

    it('moves an account to a plan on offer, and to no other', async () => {
      await svc.createPlan(PRO);
      expect((await svc.changePlan('u1', 'pro')).id).toBe('pro');
      expect((await repo.getUserPlan('u1')).id).toBe('pro');
      await expect(svc.changePlan('u1', 'nope')).rejects.toMatchObject({ status: 404 });

      await svc.updatePlan('pro', { active: false });
      await expect(svc.changePlan('u2', 'pro')).rejects.toMatchObject({ status: 409 });
      // An account already on a retired plan stays on it.
      expect((await repo.getUserPlan('u1')).id).toBe('pro');
    });

    // Otherwise: run on the expensive plan all month, switch to the cheap one on the 30th.
    it('charges what ran before a switch at the old rate and what runs after at the new one', async () => {
      await svc.createPlan(PRO); // €3/h; the default here is €1/h
      await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 50, ramPercent: 50 } });
      await svc.handleServerStarted({ deploymentId: 'd1' });
      clock = '2026-07-01T02:00:00.000Z';
      await svc.changePlan('u1', 'pro');
      clock = '2026-07-01T03:00:00.000Z';
      // 2h × €1 + 1h × €3
      expect(await svc.getUsage('u1')).toMatchObject({ hours: 3, cost: 5 });
      expect((await repo.listIntervals('u1')).filter((i) => i.stoppedAt === null)).toHaveLength(1);
    });
  });

  describe('the provider’s view (#369)', () => {
    it('lists every account with its plan, balance, usage and what is running', async () => {
      await repo.setBalance('u1', 10);
      await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 50, ramPercent: 50 } });
      await svc.handleServerStarted({ deploymentId: 'd1' });
      await svc.handleDeploymentCreated({ deploymentId: 'd2', userId: 'u2' }); // never started, never paid
      clock = '2026-07-01T04:00:00.000Z';

      const accounts = await svc.listAccounts();
      expect(accounts.find((a) => a.userId === 'u1')).toMatchObject({ planId: DEFAULT_PLAN.id, balance: 10, available: 6, canRun: true, hours: 4, cost: 4, runningServers: 1 });
      expect(accounts.find((a) => a.userId === 'u2')).toMatchObject({ balance: 0, runningServers: 0, canRun: false });
    });

    it('adds and removes credit by hand, on the ledger, saying who and why', async () => {
      const added = await svc.adjustCredit('u1', 25, 'goodwill after the outage', 'owner@host.example');
      expect(added.wallet.balance).toBe(25);
      expect(added.entry).toMatchObject({ type: 'topup', amount: 25, status: 'confirmed', description: 'Credit added by owner@host.example: goodwill after the outage' });

      const removed = await svc.adjustCredit('u1', -5.5, 'charged back', 'owner@host.example');
      expect(removed.wallet.balance).toBe(19.5);
      expect(removed.entry).toMatchObject({ type: 'charge', amount: 5.5, description: expect.stringContaining('Credit removed') });
    });

    it('refuses an adjustment with no amount, no reason, or one that looks like a typo', async () => {
      await expect(svc.adjustCredit('u1', 0, 'x', 'a')).rejects.toMatchObject({ status: 400 });
      await expect(svc.adjustCredit('u1', 5, '  ', 'a')).rejects.toMatchObject({ status: 400 });
      await expect(svc.adjustCredit('u1', 1_000_000, 'oops', 'a')).rejects.toMatchObject({ status: 400 });
      expect((await repo.getWallet('u1')).balance).toBe(0);
    });
  });

  describe('top-up flow', () => {
    it('emits payment.request and holds a pending ledger entry', async () => {
      const { reference, entry } = await svc.requestTopUp('u1', 20);
      expect(entry.status).toBe('pending');
      expect((await repo.getWallet('u1')).balance).toBe(0);

      expect(published).toHaveLength(1);
      expect(published[0].key).toBe('bank.payment.request');
      const payload = readPayload(published[0].envelope.event);
      expect(payload.reference).toBe(reference);
      expect(payload.senderWalletId).toBe('u1');
      expect(payload.receiverWalletId).toBe('nexus-wallet');
      expect(payload.amount).toBe(20);
    });

    it('adds credit on payment.confirmed', async () => {
      const { reference } = await svc.requestTopUp('u1', 20);
      const wallet = await svc.handlePaymentConfirmed({ reference, amount: 20 });
      expect(wallet?.balance).toBe(20);
      const ledger = await repo.listLedger('u1');
      expect(ledger[0].status).toBe('confirmed');
    });

    it('tells FinVault who to ask, by the address it was given (#351)', async () => {
      await svc.requestTopUp('u1', 20, undefined, 'u1@example.com');
      expect(readPayload(published[0].envelope.event).customerEmail).toBe('u1@example.com');
    });

    it('keeps FinVault’s reason when a top-up fails', async () => {
      const { reference } = await svc.requestTopUp('u1', 20);
      const failed = await svc.handlePaymentFailed({ reference, reason: 'the customer declined the request' });
      expect(failed?.failureReason).toBe('the customer declined the request');
      expect((await repo.listLedger('u1'))[0]).toMatchObject({ status: 'failed', failureReason: 'the customer declined the request' });
    });

    it('refuses another top-up while too many are waiting, and allows one again when one settles', async () => {
      const references: string[] = [];
      for (let i = 0; i < MAX_PENDING_TOPUPS; i++) references.push((await svc.requestTopUp('u1', 5)).reference);
      await expect(svc.requestTopUp('u1', 5)).rejects.toMatchObject({ status: 409 });
      expect(published).toHaveLength(MAX_PENDING_TOPUPS);
      // Somebody else's waiting top-ups are not this account's.
      await expect(svc.requestTopUp('u2', 5)).resolves.toBeTruthy();

      await svc.handlePaymentFailed({ reference: references[0], reason: 'declined' });
      await expect(svc.requestTopUp('u1', 5)).resolves.toBeTruthy();
    });

    it('fails the top-up at once when the request never reached the broker', async () => {
      const offline = createBillingService({ repo, publish: async () => false, now: () => clock });
      await expect(offline.requestTopUp('u1', 20)).rejects.toMatchObject({ status: 503 });
      const [entry] = await repo.listLedger('u1');
      expect(entry).toMatchObject({ status: 'failed', failureReason: expect.stringContaining('could not be sent') });
      expect((await repo.getWallet('u1')).balance).toBe(0);
    });

    it('marks failed on payment.failed and adds no credit', async () => {
      const { reference } = await svc.requestTopUp('u1', 20);
      await svc.handlePaymentFailed({ reference });
      expect((await repo.getWallet('u1')).balance).toBe(0);
      expect((await repo.listLedger('u1'))[0].status).toBe('failed');
    });

    it('is idempotent: a second confirm does nothing', async () => {
      const { reference } = await svc.requestTopUp('u1', 20);
      await svc.handlePaymentConfirmed({ reference, amount: 20 });
      const second = await svc.handlePaymentConfirmed({ reference, amount: 20 });
      expect(second).toBeNull();
      expect((await repo.getWallet('u1')).balance).toBe(20);
    });

    it('rejects a non-positive top-up', async () => {
      await expect(svc.requestTopUp('u1', 0)).rejects.toThrow();
    });

    // An at-least-once broker may hand the same confirmation to two deliveries at
    // once; both used to pass the "still pending?" check before either wrote.
    it('credits once when the same confirmation arrives twice at the same time (#298)', async () => {
      const { reference } = await svc.requestTopUp('u1', 20);
      const results = await Promise.all([svc.handlePaymentConfirmed({ reference, amount: 20 }), svc.handlePaymentConfirmed({ reference, amount: 20 })]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await repo.getWallet('u1')).balance).toBe(20);
    });

    it('credits nothing when FinVault confirms a different amount, and leaves it open', async () => {
      const logs: string[] = [];
      svc = createBillingService({ repo, publish: async () => true, now: () => clock, log: (m) => logs.push(m) });
      const { reference } = await svc.requestTopUp('u1', 20);
      expect(await svc.handlePaymentConfirmed({ reference, amount: 2 })).toBeNull();
      expect((await repo.getWallet('u1')).balance).toBe(0);
      expect((await repo.listLedger('u1'))[0].status).toBe('pending');
      expect(logs[0]).toMatch(/confirmed for 2 but requested for 20/);
    });

    it("ignores confirmations of FinVault's own payments, which share the routing key", async () => {
      expect(await svc.handlePaymentConfirmed({ reference: 'TXN-8F2A1C', amount: 5 })).toBeNull();
      expect(await svc.handlePaymentFailed({ reference: 'TXN-8F2A1C' })).toBeNull();
    });

    describe('when FinVault never answers (#298)', () => {
      let logs: string[];
      beforeEach(() => {
        logs = [];
        svc = createBillingService({ repo, publish: async () => true, now: () => clock, log: (m) => logs.push(m) });
      });
      const later = (ms: number) => new Date(Date.now() + ms).toISOString();

      it('shows a top-up as not confirmed once the timeout passes, and says why', async () => {
        await svc.requestTopUp('u1', 20);
        clock = later(10 * 60 * 1000);
        expect(await svc.expireStaleTopUps(30 * 60 * 1000)).toEqual([]);

        clock = later(31 * 60 * 1000);
        const expired = await svc.expireStaleTopUps(30 * 60 * 1000);
        expect(expired.map((e) => e.status)).toEqual(['expired']);
        expect((await repo.listLedger('u1'))[0].status).toBe('expired');
        expect(logs.join('\n')).toMatch(/FINVAULT_MESSAGE_KEY/);
        // Sweeping again finds nothing new.
        expect(await svc.expireStaleTopUps(30 * 60 * 1000)).toEqual([]);
      });

      it('still credits a confirmation that arrives after the top-up expired — the money moved', async () => {
        const { reference } = await svc.requestTopUp('u1', 20);
        clock = later(31 * 60 * 1000);
        await svc.expireStaleTopUps(30 * 60 * 1000);
        expect((await svc.handlePaymentConfirmed({ reference, amount: 20 }))?.balance).toBe(20);
        expect((await repo.listLedger('u1'))[0].status).toBe('confirmed');
      });

      it('records a late failure as failed', async () => {
        const { reference } = await svc.requestTopUp('u1', 20);
        clock = later(31 * 60 * 1000);
        await svc.expireStaleTopUps(30 * 60 * 1000);
        await svc.handlePaymentFailed({ reference });
        expect((await repo.listLedger('u1'))[0].status).toBe('failed');
      });

      it('never expires a top-up that was already settled', async () => {
        const { reference } = await svc.requestTopUp('u1', 20);
        await svc.handlePaymentConfirmed({ reference, amount: 20 });
        clock = later(31 * 60 * 1000);
        expect(await svc.expireStaleTopUps(30 * 60 * 1000)).toEqual([]);
        expect((await repo.listLedger('u1'))[0].status).toBe('confirmed');
      });
    });
  });
});
