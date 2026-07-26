import { describe, it, expect, beforeEach } from 'vitest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { clipIntervalHours, computeCycleCost, monthPeriodOf, previousMonthPeriod, runBillingCycle, type CyclePeriod } from './cycle.js';
import { DEFAULT_PLAN } from './pricing.js';
import type { ServerBillingRecord } from './types.js';

const JULY: CyclePeriod = { start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' };

function interval(over: Partial<ServerBillingRecord>): ServerBillingRecord {
  return {
    id: 'i', userId: 'u1', deploymentId: 'd1', planId: DEFAULT_PLAN.id, limits: {},
    startedAt: '2026-07-01T00:00:00.000Z', stoppedAt: '2026-07-01T10:00:00.000Z', createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('period helpers', () => {
  it('computes the UTC month containing a date', () => {
    expect(monthPeriodOf('2026-07-15T12:00:00.000Z')).toEqual(JULY);
  });
  it('computes the previous month', () => {
    expect(previousMonthPeriod('2026-08-03T00:00:00.000Z')).toEqual(JULY);
  });
});

describe('clipIntervalHours', () => {
  it('clips to the period bounds', () => {
    // starts before the period, runs 5h into it
    expect(clipIntervalHours(interval({ startedAt: '2026-06-30T22:00:00.000Z', stoppedAt: '2026-07-01T03:00:00.000Z' }), JULY)).toBe(3);
  });
  it('bills an open interval up to the period end', () => {
    expect(clipIntervalHours(interval({ startedAt: '2026-07-31T22:00:00.000Z', stoppedAt: null }), JULY)).toBe(2);
  });
  it('is zero for a non-overlapping interval', () => {
    expect(clipIntervalHours(interval({ startedAt: '2026-09-01T00:00:00.000Z', stoppedAt: '2026-09-02T00:00:00.000Z' }), JULY)).toBe(0);
  });
});

describe('computeCycleCost', () => {
  const plan = { ...DEFAULT_PLAN, pricePerHour: 1, freeHoursPerMonth: 4 };
  it('applies the free-hour pool across intervals then charges the factor', () => {
    const intervals = [
      interval({ deploymentId: 'd1', startedAt: '2026-07-01T00:00:00.000Z', stoppedAt: '2026-07-01T05:00:00.000Z', limits: {} }), // 5h
      interval({ deploymentId: 'd2', startedAt: '2026-07-02T00:00:00.000Z', stoppedAt: '2026-07-02T03:00:00.000Z', limits: { cpuPercent: 100, ramPercent: 100 } }), // 3h, 2×
    ];
    // pool 4h: covers all of d1's 5h? no — 4 free used on d1 → 1h billable × 1 × 1 = 1; d2 3h × 1 × 2 = 6 → total 7
    expect(computeCycleCost(intervals, plan, JULY)).toBe(7);
  });
});

describe('runBillingCycle', () => {
  let repo: InMemoryRepository;
  let published: Array<{ key: string; envelope: EventEnvelope }>;

  const run = () => runBillingCycle({ repo, publish: async (key, envelope) => { published.push({ key, envelope }); return true; } }, JULY);

  beforeEach(() => {
    repo = new InMemoryRepository([{ ...DEFAULT_PLAN, pricePerHour: 1, freeHoursPerMonth: 0 }]);
    published = [];
  });

  it('charges credit and emits an invoice when covered', async () => {
    await repo.setBalance('u1', 100);
    await repo.openInterval({ userId: 'u1', deploymentId: 'd1', planId: DEFAULT_PLAN.id, limits: {}, startedAt: '2026-07-01T00:00:00.000Z' });
    await repo.closeInterval('d1', '2026-07-01T10:00:00.000Z'); // 10h × 1 × 1 = 10

    const [outcome] = await run();
    expect(outcome.cost).toBe(10);
    expect(outcome.status).toBe('paid');
    expect((await repo.getWallet('u1')).balance).toBe(90);
    const invoice = published.find((p) => p.key === 'invoice.generate');
    expect(invoice).toBeTruthy();
    expect(readPayload(invoice!.envelope.event).amount).toBe(10);
    expect(published.some((p) => p.key === 'billing.server.suspend')).toBe(false);
  });

  it('suspends running servers when the balance cannot cover the charge', async () => {
    await repo.setBalance('u1', 3);
    await repo.openInterval({ userId: 'u1', deploymentId: 'd1', planId: DEFAULT_PLAN.id, limits: {}, startedAt: '2026-07-01T00:00:00.000Z' });
    // left open → still running at cycle close, billed to period end (well over 3)

    const [outcome] = await run();
    expect(outcome.status).toBe('overdue');
    expect(outcome.suspendedDeploymentIds).toEqual(['d1']);
    const suspend = published.find((p) => p.key === 'billing.server.suspend');
    expect(suspend).toBeTruthy();
    expect(readPayload(suspend!.envelope.event).deploymentIds).toEqual(['d1']);
    expect((await repo.getWallet('u1')).balance).toBeLessThan(0);
  });

  it('is idempotent: a second run does not double-charge', async () => {
    await repo.setBalance('u1', 100);
    await repo.openInterval({ userId: 'u1', deploymentId: 'd1', planId: DEFAULT_PLAN.id, limits: {}, startedAt: '2026-07-01T00:00:00.000Z' });
    await repo.closeInterval('d1', '2026-07-01T10:00:00.000Z');

    await run();
    const second = await run();
    expect(second).toHaveLength(0);
    expect((await repo.getWallet('u1')).balance).toBe(90);
  });

  it('records a paid zero cycle without an invoice for free-tier usage', async () => {
    const freeRepo = new InMemoryRepository([{ ...DEFAULT_PLAN, pricePerHour: 1, freeHoursPerMonth: 1000 }]);
    await freeRepo.openInterval({ userId: 'u1', deploymentId: 'd1', planId: DEFAULT_PLAN.id, limits: {}, startedAt: '2026-07-01T00:00:00.000Z' });
    await freeRepo.closeInterval('d1', '2026-07-01T10:00:00.000Z');
    const pub: Array<{ key: string; envelope: EventEnvelope }> = [];
    const [outcome] = await runBillingCycle({ repo: freeRepo, publish: async (key, envelope) => { pub.push({ key, envelope }); return true; } }, JULY);
    expect(outcome.cost).toBe(0);
    expect(outcome.status).toBe('paid');
    expect(pub).toHaveLength(0);
    expect((await freeRepo.listCycles('u1'))[0].totalCost).toBe(0);
  });
});
