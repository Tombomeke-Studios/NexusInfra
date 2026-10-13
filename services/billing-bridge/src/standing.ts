import { roundCurrency, type BillingPlan } from './pricing.js';
import { clipIntervalHours, computeCycleCost, monthPeriodOf, previousMonthPeriod, type CyclePeriod } from './cycle.js';
import type { BillingCycleRecord, ServerBillingRecord } from './types.js';

// An account's standing: what it has, what it has used and not yet been charged
// for, and whether it may run servers (#365). Pure — balance, intervals and plan
// in, a verdict out.
//
// Credit used to be looked at once a month, when the cycle runner charged the
// month that had closed. Until then nothing compared usage with the balance, so
// "prepaid" meant a month of servers for nothing, and a server the cycle had
// stopped could simply be started again.

export interface Usage {
  /** Hours run in the period, across all servers. */
  hours: number;
  /** What those hours cost after the plan's free hours. */
  cost: number;
}

export interface Standing {
  balance: number;
  /** Used and not yet charged to the balance: this month so far, plus a closed month the cycle has not billed yet. */
  accrued: number;
  /** `balance - accrued` — what is actually left to spend. */
  available: number;
  /** Free hours the plan still grants this month. */
  freeHoursLeft: number;
  canRun: boolean;
  currency: string;
}

/**
 * Hours and cost of `intervals` within `period`, as the cycle runner would
 * charge them. An interval still open counts up to the period's end, so pass a
 * period that ends *now* for a month in progress.
 */
export function usageIn(intervals: ServerBillingRecord[], plan: BillingPlan, period: CyclePeriod): Usage {
  const hours = intervals.reduce((sum, i) => sum + clipIntervalHours(i, period), 0);
  return { hours: Math.round(hours * 1000) / 1000, cost: computeCycleCost(intervals, plan, period) };
}

/** The month in progress, ending now rather than at the end of the month. */
export function currentPeriod(now: string): CyclePeriod {
  return { start: monthPeriodOf(now).start, end: now };
}

export function computeStanding(input: {
  balance: number;
  currency: string;
  intervals: ServerBillingRecord[];
  cycles: Pick<BillingCycleRecord, 'periodStart'>[];
  plan: BillingPlan;
  now: string;
}): Standing {
  const { balance, intervals, cycles, plan, now } = input;
  const thisMonth = usageIn(intervals, plan, currentPeriod(now));

  // The cycle runner polls hourly, so just after a month closes its usage is in
  // neither the balance nor the month in progress. Count it until it is charged.
  const previous = previousMonthPeriod(now);
  const previousBilled = cycles.some((c) => c.periodStart === previous.start);
  const unbilledPrevious = previousBilled ? 0 : usageIn(intervals, plan, previous).cost;

  const accrued = roundCurrency(thisMonth.cost + unbilledPrevious);
  const available = roundCurrency(balance - accrued);
  const freeHoursLeft = Math.max(0, Math.round((plan.freeHoursPerMonth - thisMonth.hours) * 1000) / 1000);

  return {
    balance,
    accrued,
    available,
    freeHoursLeft,
    // Credit left to spend — or nothing owed and free hours still to use, which
    // is how a plan with a free allowance lets a new account start at all.
    canRun: available > 0 || (available >= 0 && freeHoursLeft > 0),
    currency: input.currency,
  };
}
