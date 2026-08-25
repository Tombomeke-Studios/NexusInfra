import { buildEnvelope, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent } from 'shared';
import { resourceFactor, roundCurrency, type BillingPlan } from './pricing.js';
import { hoursBetween } from './tracking.js';
import { applyCharge, canCover } from './wallet.js';
import type { CycleStatus, Repository, ServerBillingRecord } from './types.js';

// Monthly billing cycle runner (hosted edition). At cycle close it aggregates
// each user's runtime, draws the cost from their credit, suspends their servers
// when the balance can't cover it, and emits an invoice. The aggregation is pure
// (computeCycleCost); side effects are injected so runBillingCycle is testable
// with the in-memory repo and a captured publisher.

const KEY_SUSPEND = 'billing.server.suspend';
const KEY_INVOICE = 'invoice.generate';

export interface CyclePeriod {
  /** Inclusive ISO start of the period. */
  start: string;
  /** Exclusive ISO end of the period. */
  end: string;
}

/** The UTC calendar month containing `iso` (start inclusive, end exclusive). */
export function monthPeriodOf(iso: string): CyclePeriod {
  const d = new Date(iso);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** The UTC calendar month before the one containing `iso` — the one the runner bills. */
export function previousMonthPeriod(iso: string): CyclePeriod {
  const { start } = monthPeriodOf(iso);
  return monthPeriodOf(new Date(new Date(start).getTime() - 1).toISOString());
}

/** Hours of a runtime interval that fall within the period (open intervals bill up to period end). */
export function clipIntervalHours(interval: ServerBillingRecord, period: CyclePeriod): number {
  const start = Math.max(new Date(interval.startedAt).getTime(), new Date(period.start).getTime());
  const stop = Math.min(new Date(interval.stoppedAt ?? period.end).getTime(), new Date(period.end).getTime());
  if (stop <= start) return 0;
  return hoursBetween(new Date(start).toISOString(), new Date(stop).toISOString());
}

/**
 * The total charge for a user's intervals within the period: the plan's monthly
 * free-hour grant is a single pool spent (in interval order) across servers;
 * remaining billable hours are charged at each server's resource factor.
 */
export function computeCycleCost(intervals: ServerBillingRecord[], plan: BillingPlan, period: CyclePeriod): number {
  const ordered = [...intervals].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let remainingFree = plan.freeHoursPerMonth;
  let cost = 0;
  for (const i of ordered) {
    const h = clipIntervalHours(i, period);
    if (h <= 0) continue;
    const freeApplied = Math.min(remainingFree, h);
    remainingFree -= freeApplied;
    cost += (h - freeApplied) * plan.pricePerHour * resourceFactor(i.limits);
  }
  return roundCurrency(cost);
}

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

export interface CycleRunnerDeps {
  repo: Repository;
  publish?: PublishFn;
  now?: () => string;
}

export interface CycleOutcome {
  userId: string;
  cost: number;
  status: CycleStatus;
  suspendedDeploymentIds: string[];
}

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * Bill every user for `period` once. Idempotent: a user already billed for the
 * period (a cycle record exists) is skipped, so re-runs and frequent polling are
 * safe. Returns a per-user outcome for logging/tests.
 */
export async function runBillingCycle(deps: CycleRunnerDeps, period: CyclePeriod): Promise<CycleOutcome[]> {
  const { repo } = deps;
  const publish = deps.publish ?? publishRabbitEvent;
  const emit = (routingKey: string, event: NexusInfraEvent) => publish(routingKey, buildEnvelope('billing-bridge', event));

  const outcomes: CycleOutcome[] = [];
  for (const userId of await repo.listBillableUserIds()) {
    const alreadyBilled = (await repo.listCycles(userId)).some((c) => c.periodStart === period.start);
    if (alreadyBilled) continue;

    const [plan, intervals] = await Promise.all([repo.getUserPlan(userId), repo.listIntervals(userId)]);
    const cost = computeCycleCost(intervals, plan, period);

    let status: CycleStatus = 'paid';
    let suspendedDeploymentIds: string[] = [];

    if (cost > 0) {
      const wallet = await repo.getWallet(userId);
      const covered = canCover(wallet.balance, cost);
      await repo.createLedgerEntry({
        userId,
        type: 'charge',
        amount: cost,
        currency: plan.currency,
        reference: `charge-${period.start}-${userId}`,
        status: 'confirmed',
        description: `Usage ${period.start} – ${period.end}`,
      });
      await repo.setBalance(userId, applyCharge(wallet.balance, cost));

      if (!covered) {
        status = 'overdue';
        suspendedDeploymentIds = unique(intervals.filter((i) => i.stoppedAt === null).map((i) => i.deploymentId));
        if (suspendedDeploymentIds.length > 0) {
          await emit(KEY_SUSPEND, { type: 'billing.server.suspend', payload: { userId, deploymentIds: suspendedDeploymentIds, reason: 'credit exhausted' } });
        }
      }

      await emit(KEY_INVOICE, {
        type: 'invoice.generate',
        payload: { reference: `invoice-${period.start}-${userId}`, userId, periodStart: period.start, periodEnd: period.end, amount: cost, currency: plan.currency },
      });
    }

    await repo.createCycle({ userId, periodStart: period.start, periodEnd: period.end, totalCost: cost, currency: plan.currency, status });
    outcomes.push({ userId, cost, status, suspendedDeploymentIds });
  }
  return outcomes;
}

/**
 * Poll for a closed month and bill it (once). Default cadence is hourly; the
 * idempotency guard means the previous month is charged exactly once after it ends.
 */
export function startCycleRunner(deps: CycleRunnerDeps, pollMs = 60 * 60 * 1000): () => void {
  const now = deps.now ?? (() => new Date().toISOString());
  const tick = async () => {
    try {
      await runBillingCycle(deps, previousMonthPeriod(now()));
    } catch (err) {
      console.error('[BillingBridge] cycle run failed:', err instanceof Error ? err.message : err);
    }
  };
  void tick();
  const handle = setInterval(() => void tick(), pollMs);
  return () => clearInterval(handle);
}
