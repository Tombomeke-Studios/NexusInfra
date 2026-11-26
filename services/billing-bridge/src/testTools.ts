import { Router, type Request, type Response } from 'express';
import type { BillingPlan } from './pricing.js';
import type { Repository } from './types.js';

// TEMPORARY test tools for the hosted billing (#439). Off unless
// BILLING_TEST_TOOLS=true; never turn this on for real customers.
//
// Billing is driven by the clock — free hours, the monthly cycle, running out of
// credit — so testing it meant waiting for it. These tools do not add a second
// billing calculation; they steer the real one:
//
// - **Move time forward**: a clock offset the billing service and the cycle
//   runner read instead of the wall clock. Forward only, because an interval
//   opened at a later "now" must never end before it began. Crossing a month
//   boundary runs that month's real cycle (charge, suspend, invoice) at once.
//   The offset lives in memory: restarting the bridge returns to the real time.
// - **Free hours and the hourly rate**: both are plan properties, and runtime is
//   charged at the rate of the plan it ran under (#369). So an account gets its
//   own retired test plan — a copy of its current one with the new numbers — and
//   is moved onto it. Retired means no other account can pick it.

export function testToolsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BILLING_TEST_TOOLS === 'true';
}

/** The longest single jump: enough to cross a year of cycles, not enough to overflow a date by accident. */
export const MAX_ADVANCE_HOURS = 24 * 400;

export interface TestClock {
  /** The billing "now": the wall clock plus the offset. */
  now(): string;
  offsetHours(): number;
  /** Move forward by `hours` (> 0, at most MAX_ADVANCE_HOURS). */
  advance(hours: number): void;
}

export function createTestClock(wall: () => number = Date.now): TestClock {
  let offsetMs = 0;
  return {
    now: () => new Date(wall() + offsetMs).toISOString(),
    offsetHours: () => offsetMs / 3_600_000,
    advance(hours: number) {
      if (!(Number.isFinite(hours) && hours > 0 && hours <= MAX_ADVANCE_HOURS)) {
        throw new TestToolError(`time only moves forward, by more than 0 and at most ${MAX_ADVANCE_HOURS} hours`);
      }
      offsetMs += hours * 3_600_000;
    },
  };
}

export class TestToolError extends Error {}

/** The id of an account's own test plan. */
export function testPlanId(userId: string): string {
  return `test-${userId}`;
}

/**
 * The account's test plan: its current plan with the new rate and/or free hours,
 * retired so nobody else can choose it. Validated here because it bypasses the
 * catalogue's own input checks.
 */
export function testPlanFor(current: BillingPlan, userId: string, change: { pricePerHour?: unknown; freeHoursPerMonth?: unknown }): BillingPlan {
  const pricePerHour = change.pricePerHour === undefined ? current.pricePerHour : change.pricePerHour;
  const freeHoursPerMonth = change.freeHoursPerMonth === undefined ? current.freeHoursPerMonth : change.freeHoursPerMonth;
  if (typeof pricePerHour !== 'number' || !Number.isFinite(pricePerHour) || pricePerHour < 0 || pricePerHour > 1000) {
    throw new TestToolError('the hourly rate must be a number from 0 to 1000');
  }
  if (typeof freeHoursPerMonth !== 'number' || !Number.isFinite(freeHoursPerMonth) || freeHoursPerMonth < 0 || freeHoursPerMonth > 100_000) {
    throw new TestToolError('free hours must be a number from 0 to 100000');
  }
  const base = current.id === testPlanId(userId) ? current.name.replace(/^Test plan \((.*)\)$/, '$1') : current.name;
  return { ...current, id: testPlanId(userId), name: `Test plan (${base})`, pricePerHour, freeHoursPerMonth, active: false };
}

export interface TestToolDeps {
  repo: Repository;
  clock: TestClock;
  /** After the clock moves: settle running accounts and run any cycle that closed. */
  afterAdvance: () => Promise<void>;
}

/** The routes, behind the bridge's internal token like every other route. */
export function createTestToolRouter({ repo, clock, afterAdvance }: TestToolDeps): Router {
  const router = Router();
  const fail = (res: Response, err: unknown) =>
    err instanceof TestToolError ? res.status(400).json({ error: err.message }) : res.status(500).json({ error: 'the test tool failed' });

  const clockView = () => ({ now: clock.now(), offsetHours: Math.round(clock.offsetHours() * 1000) / 1000 });

  router.get('/test/clock', (_req: Request, res: Response) => res.json(clockView()));

  router.post('/test/clock', async (req: Request, res: Response) => {
    try {
      clock.advance(Number((req.body ?? {}).hours));
      await afterAdvance();
      res.json(clockView());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/test/accounts/:userId/plan', async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;
      const plan = testPlanFor(await repo.getUserPlan(userId), userId, req.body ?? {});
      await repo.savePlan(plan);
      await repo.setUserPlan(userId, plan.id);
      res.json(plan);
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
