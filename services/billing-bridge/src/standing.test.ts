import { describe, it, expect } from 'vitest';
import { DEFAULT_PLAN, type BillingPlan } from './pricing.js';
import { computeStanding, currentPeriod, usageIn } from './standing.js';
import type { ServerBillingRecord } from './types.js';

// €1/hour at the standard size, no free hours unless a test says so.
const PLAN: BillingPlan = { ...DEFAULT_PLAN, pricePerHour: 1, freeHoursPerMonth: 0 };
const STANDARD = { cpuPercent: 50, ramPercent: 50 };

let n = 0;
const ran = (startedAt: string, stoppedAt: string | null, deploymentId = 'd1'): ServerBillingRecord => ({
  id: `i${++n}`,
  userId: 'u1',
  deploymentId,
  planId: PLAN.id,
  limits: STANDARD,
  startedAt,
  stoppedAt,
  createdAt: startedAt,
});

const NOW = '2026-07-10T12:00:00.000Z';
const standing = (over: Partial<Parameters<typeof computeStanding>[0]> = {}) =>
  computeStanding({ balance: 0, currency: 'EUR', intervals: [], cycles: [{ periodStart: '2026-06-01T00:00:00.000Z' }], plan: PLAN, now: NOW, ...over });

describe('usageIn', () => {
  it('counts only what falls inside the period', () => {
    const intervals = [ran('2026-06-30T22:00:00.000Z', '2026-07-01T03:00:00.000Z'), ran('2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z')];
    expect(usageIn(intervals, PLAN, currentPeriod(NOW))).toEqual({ hours: 3, cost: 3 });
  });

  it('counts a server still running up to now, not to the end of the month', () => {
    expect(usageIn([ran('2026-07-10T10:00:00.000Z', null)], PLAN, currentPeriod(NOW))).toEqual({ hours: 2, cost: 2 });
  });

  it('spends the free hours before charging', () => {
    const plan = { ...PLAN, freeHoursPerMonth: 5 };
    expect(usageIn([ran('2026-07-10T04:00:00.000Z', null)], plan, currentPeriod(NOW))).toEqual({ hours: 8, cost: 3 });
  });
});

describe('computeStanding (#365)', () => {
  it('lets an account with credit and no usage run', () => {
    expect(standing({ balance: 10 })).toMatchObject({ balance: 10, accrued: 0, available: 10, canRun: true });
  });

  it('refuses an account with no credit on a plan with no free hours', () => {
    expect(standing()).toMatchObject({ available: 0, freeHoursLeft: 0, canRun: false });
  });

  it('lets a new account use the free hours its plan grants', () => {
    expect(standing({ plan: { ...PLAN, freeHoursPerMonth: 100 } })).toMatchObject({ available: 0, freeHoursLeft: 100, canRun: true });
  });

  it('takes this month’s uncharged usage off what is left', () => {
    const s = standing({ balance: 10, intervals: [ran('2026-07-10T08:00:00.000Z', null)] });
    expect(s).toMatchObject({ accrued: 4, available: 6, canRun: true });
  });

  it('stops an account once what it has used reaches what it has', () => {
    const s = standing({ balance: 4, intervals: [ran('2026-07-10T08:00:00.000Z', null)] });
    expect(s).toMatchObject({ accrued: 4, available: 0, canRun: false });
  });

  it('does not let free hours carry an account that already owes', () => {
    const s = standing({ balance: -2, plan: { ...PLAN, freeHoursPerMonth: 100 } });
    expect(s).toMatchObject({ available: -2, freeHoursLeft: 100, canRun: false });
  });

  // The cycle runner polls hourly: just after midnight on the 1st, last month is
  // in neither the balance nor the new month.
  it('counts a closed month the cycle has not charged yet, and stops once it has', () => {
    const june = [ran('2026-06-30T00:00:00.000Z', '2026-06-30T05:00:00.000Z')];
    expect(standing({ balance: 10, intervals: june, cycles: [] })).toMatchObject({ accrued: 5, available: 5 });
    expect(standing({ balance: 5, intervals: june })).toMatchObject({ accrued: 0, available: 5 });
  });
});
