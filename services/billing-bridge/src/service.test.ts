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
