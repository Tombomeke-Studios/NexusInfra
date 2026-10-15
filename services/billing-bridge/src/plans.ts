import { DEFAULT_PLAN, type BillingPlan } from './pricing.js';

// The plan catalogue (#369), pure: turning what an administrator typed into a
// plan, and deciding whether an account may move to one. There used to be one
// plan, seeded at first start, that every account got and nobody could change.

export const MAX_PLAN_NAME = 60;

export type PlanInput = Omit<BillingPlan, 'id' | 'currency'>;

export type PlanParse = { ok: true; plan: PlanInput } | { ok: false; error: string };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A ceiling: a whole number of at least `min`, or null/absent for none. */
function ceiling(value: unknown, label: string, min: number): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  if (!isNumber(value) || !Number.isInteger(value) || value < min) return { ok: false, error: `${label} must be a whole number of at least ${min}, or empty for no limit` };
  return { ok: true, value };
}

/**
 * Validate a plan as submitted. `base` supplies what an edit leaves out, so a
 * form may send only what changed.
 */
export function parsePlanInput(body: unknown, base?: BillingPlan): PlanParse {
  const b = (body ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof PlanInput>(key: K): unknown => (key in b ? b[key] : base?.[key]);

  const name = pick('name');
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'a plan needs a name' };
  if (name.trim().length > MAX_PLAN_NAME) return { ok: false, error: `the name is longer than ${MAX_PLAN_NAME} characters` };

  const pricePerHour = pick('pricePerHour');
  if (!isNumber(pricePerHour) || pricePerHour < 0) return { ok: false, error: 'the hourly price must be zero or more' };

  const freeHoursPerMonth = pick('freeHoursPerMonth') ?? 0;
  if (!isNumber(freeHoursPerMonth) || freeHoursPerMonth < 0) return { ok: false, error: 'free hours must be zero or more' };

  const maxServers = pick('maxServers');
  if (!isNumber(maxServers) || !Number.isInteger(maxServers) || maxServers < 0) return { ok: false, error: 'the server limit must be a whole number, zero or more' };
  const maxDatabases = pick('maxDatabases');
  if (!isNumber(maxDatabases) || !Number.isInteger(maxDatabases) || maxDatabases < 0) return { ok: false, error: 'the database limit must be a whole number, zero or more' };

  const maxRamMb = ceiling(pick('maxRamMb'), 'the memory ceiling (MB)', 128);
  if (!maxRamMb.ok) return maxRamMb;
  const maxBackupsPerServer = ceiling(pick('maxBackupsPerServer'), 'the backups-per-server ceiling', 1);
  if (!maxBackupsPerServer.ok) return maxBackupsPerServer;

  const active = pick('active') ?? true;
  if (typeof active !== 'boolean') return { ok: false, error: 'active must be true or false' };

  return {
    ok: true,
    plan: { name: name.trim(), pricePerHour, freeHoursPerMonth, maxServers, maxDatabases, maxRamMb: maxRamMb.value, maxBackupsPerServer: maxBackupsPerServer.value, active },
  };
}

/** An id from a name: lower-case words joined by dashes. Empty when the name has nothing usable. */
export function planIdFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Why a plan may not be retired, or null. The default plan is what an account
 * with no assignment falls back to — and what a new account gets — so there has
 * to be one that can be chosen.
 */
export function retireProblem(plan: BillingPlan): string | null {
  if (plan.id === DEFAULT_PLAN.id) return 'the default plan cannot be retired: every new account starts on it';
  return null;
}

/**
 * Why an account may not move to `target`, or null. A retired plan keeps the
 * accounts it has, but nobody new may choose it.
 */
export function switchProblem(target: BillingPlan | null, currentPlanId: string): string | null {
  if (!target) return 'no such plan';
  if (target.id === currentPlanId) return null;
  if (!target.active) return `the ${target.name} plan is no longer offered`;
  return null;
}
