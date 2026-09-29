import type { ResourceLimits } from 'shared';

// Pure pricing core (hosted edition). Cost for a server over a cycle is:
//
//   cost = billableHours × plan.pricePerHour × resourceFactor(limits)
//
// where billableHours applies the plan's monthly free-hour grant. Everything here
// is a pure function of its inputs so it is trivially testable and has no I/O.

/** A tunable pricing/quota plan (persisted in billing_plans so rates change without code). */
export interface BillingPlan {
  id: string;
  name: string;
  /** Base rate charged per runtime hour before the resource factor. */
  pricePerHour: number;
  currency: string;
  /** Free runtime hours granted each month before charging begins. */
  freeHoursPerMonth: number;
  /** Max concurrent servers a user on this plan may have. */
  maxServers: number;
  /** Max managed databases a user on this plan may have. */
  maxDatabases: number;
  /**
   * Memory the plan lets a user commit across all their servers, in MB (#297);
   * null for no ceiling. A total rather than a per-server cap, so it cannot be
   * multiplied by creating more servers.
   */
  maxRamMb: number | null;
  /** How many backups each server keeps at most (#297); null for no ceiling. */
  maxBackupsPerServer: number | null;
}

/** The default plan used when a user has none assigned (keeps community-style usage free-ish). */
export const DEFAULT_PLAN: BillingPlan = {
  id: 'standard',
  name: 'Standard',
  pricePerHour: 0.02,
  currency: 'EUR',
  freeHoursPerMonth: 100,
  maxServers: 5,
  maxDatabases: 5,
  maxRamMb: 8192,
  maxBackupsPerServer: 10,
};

// A "standard unit" is 50% CPU + 50% RAM of a node → factor 1.0. Bigger servers
// cost proportionally more; the factor never drops below a small floor so a tiny
// server still contributes something.
const STANDARD_CPU = 50;
const STANDARD_RAM = 50;
const MIN_FACTOR = 0.25;

/** Round to cents to avoid floating-point noise in money math. */
export function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * The resource multiplier for a server, derived from its chosen CPU/RAM limits.
 * Absent limits are treated as a standard unit (factor 1.0).
 */
export function resourceFactor(limits: ResourceLimits = {}): number {
  const cpu = typeof limits.cpuPercent === 'number' ? limits.cpuPercent : STANDARD_CPU;
  const ram = typeof limits.ramPercent === 'number' ? limits.ramPercent : STANDARD_RAM;
  const factor = (cpu + ram) / (STANDARD_CPU + STANDARD_RAM);
  return Math.max(MIN_FACTOR, roundCurrency(factor));
}

/** Hours beyond the plan's monthly free-hour grant, floored at zero. */
export function billableHours(totalHours: number, plan: BillingPlan): number {
  return Math.max(0, totalHours - plan.freeHoursPerMonth);
}

export interface ChargeInput {
  totalHours: number;
  plan: BillingPlan;
  limits?: ResourceLimits;
}

/**
 * The charge for a server's runtime this cycle: billable (post-free) hours ×
 * base rate × resource factor, rounded to cents. Free-tier usage returns 0.
 */
export function computeCharge({ totalHours, plan, limits }: ChargeInput): number {
  const hours = billableHours(totalHours, plan);
  return roundCurrency(hours * plan.pricePerHour * resourceFactor(limits));
}

/**
 * How this plan charges, as data the panel can state (#297). A customer who
 * cannot predict the bill reads "nothing was charged when I created a server"
 * as a bug rather than as the model — so the model is said out loud, from the
 * same constants the charge is computed with.
 */
export interface ChargingModel {
  /** Charged per hour a server runs; creating one, or leaving it stopped, costs nothing. */
  basis: 'runtime-hours';
  pricePerHour: number;
  currency: string;
  /** Shared by all of a user's servers, per calendar month. */
  freeHoursPerMonth: number;
  /** The size multiplier: (cpu% + ram%) / (standard cpu% + standard ram%), never below `minimum`. */
  sizeFactor: { standardCpuPercent: number; standardRamPercent: number; minimum: number };
}

export function chargingModel(plan: BillingPlan): ChargingModel {
  return {
    basis: 'runtime-hours',
    pricePerHour: plan.pricePerHour,
    currency: plan.currency,
    freeHoursPerMonth: plan.freeHoursPerMonth,
    sizeFactor: { standardCpuPercent: STANDARD_CPU, standardRamPercent: STANDARD_RAM, minimum: MIN_FACTOR },
  };
}
