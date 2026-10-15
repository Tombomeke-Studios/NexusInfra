import { resourceFactor, roundCurrency, type BillingPlan } from './pricing.js';
import { clipIntervalHours, computeCycleCost, monthPeriodOf, previousMonthPeriod, type CyclePeriod, type RateOf } from './cycle.js';
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
  /**
   * How many hours what is left lasts at the rate the running servers spend it,
   * free hours counted (#379). Null when nothing is running, or nothing running
   * costs anything — there is no rate to divide by. An estimate: it assumes the
   * servers keep running as they are, and does not count next month's free hours.
   */
  hoursLeft: number | null;
  /** Whether `hoursLeft` is under the warning threshold (#379). */
  runsLow: boolean;
}

/** Below this many hours of credit an account is warned, unless `LOW_CREDIT_HOURS` says otherwise (#379). */
export const DEFAULT_LOW_CREDIT_HOURS = 24;

/** `LOW_CREDIT_HOURS` as a positive number of hours, or the default. */
export function parseLowCreditHours(raw: string | undefined): number {
  const hours = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_LOW_CREDIT_HOURS;
}

/**
 * What the running servers cost an hour once the free hours are spent, and how
 * many of them are running — the free hours are one pool, spent by every running
 * server at once.
 */
export function burnRate(intervals: ServerBillingRecord[], plan: BillingPlan, rateOf?: RateOf): { perHour: number; running: number } {
  const open = new Map<string, ServerBillingRecord>();
  for (const i of intervals) if (i.stoppedAt === null) open.set(i.deploymentId, i);
  let perHour = 0;
  for (const i of open.values()) perHour += (rateOf?.(i.planId) ?? plan.pricePerHour) * resourceFactor(i.limits);
  return { perHour, running: open.size };
}

/**
 * Hours until what is left is spent: the free hours first (spent by every
 * running server at once), then `available` at the running servers' rate.
 */
export function runwayHours(input: { available: number; freeHoursLeft: number; perHour: number; running: number }): number | null {
  const { available, freeHoursLeft, perHour, running } = input;
  if (running === 0 || perHour <= 0) return null;
  const free = available >= 0 ? freeHoursLeft / running : 0;
  return Math.round((free + Math.max(0, available) / perHour) * 10) / 10;
}

/**
 * What to do about the low-credit warning (#379): warn the first time the
 * runway drops under the threshold, forget the warning once it lasts the
 * threshold again — so the next dip warns again — and otherwise nothing. While
 * no server runs there is no runway, and that changes nothing: stopping the
 * servers is not topping up.
 */
export function lowCreditStep(hoursLeft: number | null, thresholdHours: number, warnedAt: string | null): 'warn' | 'clear' | 'none' {
  if (hoursLeft === null) return 'none';
  if (hoursLeft < thresholdHours) return warnedAt ? 'none' : 'warn';
  return warnedAt ? 'clear' : 'none';
}

/**
 * Hours and cost of `intervals` within `period`, as the cycle runner would
 * charge them. An interval still open counts up to the period's end, so pass a
 * period that ends *now* for a month in progress.
 */
export function usageIn(intervals: ServerBillingRecord[], plan: BillingPlan, period: CyclePeriod, rateOf?: RateOf): Usage {
  const hours = intervals.reduce((sum, i) => sum + clipIntervalHours(i, period), 0);
  return { hours: Math.round(hours * 1000) / 1000, cost: computeCycleCost(intervals, plan, period, rateOf) };
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
  /** Rates of the plans intervals ran under (#369); without it everything is charged at `plan`'s. */
  rateOf?: RateOf;
  /** The warning threshold in hours (#379); `DEFAULT_LOW_CREDIT_HOURS` when not given. */
  lowCreditHours?: number;
}): Standing {
  const { balance, intervals, cycles, plan, now, rateOf } = input;
  const thisMonth = usageIn(intervals, plan, currentPeriod(now), rateOf);

  // The cycle runner polls hourly, so just after a month closes its usage is in
  // neither the balance nor the month in progress. Count it until it is charged.
  const previous = previousMonthPeriod(now);
  const previousBilled = cycles.some((c) => c.periodStart === previous.start);
  const unbilledPrevious = previousBilled ? 0 : usageIn(intervals, plan, previous, rateOf).cost;

  const accrued = roundCurrency(thisMonth.cost + unbilledPrevious);
  const available = roundCurrency(balance - accrued);
  const freeHoursLeft = Math.max(0, Math.round((plan.freeHoursPerMonth - thisMonth.hours) * 1000) / 1000);
  const hoursLeft = runwayHours({ available, freeHoursLeft, ...burnRate(intervals, plan, rateOf) });

  return {
    hoursLeft,
    runsLow: hoursLeft !== null && hoursLeft < (input.lowCreditHours ?? DEFAULT_LOW_CREDIT_HOURS),
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
