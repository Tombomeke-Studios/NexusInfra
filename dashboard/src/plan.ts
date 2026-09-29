import type { ChargingModel, EntitlementUsage, Entitlements } from './api';

// Plain-language plan maths for the hosted panel (#297). Hosted-only: nothing in
// a community build imports this, so none of it reaches that bundle.
//
// The server is the authority — it measures and refuses. This exists so the
// form can say the same thing *before* anyone presses Create, with the same
// numbers, instead of the plan being discovered by a refusal.

/** Megabytes the way people say them: 512 MB, 2 GB, 1.5 GB. */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${Math.round(mb)} MB`;
}

const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 4 }).format(amount);

/**
 * How the plan charges, in one paragraph a customer can predict a bill from.
 * Built from the model the bridge charges with, so the sentence cannot drift
 * from the arithmetic.
 */
export function chargingSentence(c: ChargingModel): string {
  const size = `a server with ${c.sizeFactor.standardCpuPercent}% CPU and ${c.sizeFactor.standardRamPercent}% RAM counts once, bigger ones proportionally more, and none less than ${c.sizeFactor.minimum}×`;
  const free = c.freeHoursPerMonth > 0 ? ` The first ${c.freeHoursPerMonth} hours each month are free, shared across all your servers.` : '';
  return `You pay ${money(c.pricePerHour, c.currency)} for each hour a server runs, scaled by its size: ${size}.${free} Creating a server costs nothing, and neither does a stopped one.`;
}

export type RamVerdict =
  | { kind: 'unlimited' }
  | { kind: 'unknown' }
  | { kind: 'fits'; afterMb: number; maxMb: number }
  | { kind: 'over'; neededMb: number; leftMb: number; maxMb: number }
  | { kind: 'uncapped'; maxMb: number };

/** Whether a server of `requestedMb` fits what is left of the plan — the server's own rule, mirrored. */
export function ramVerdict(entitlements: Entitlements, usage: EntitlementUsage, requestedMb: number | null): RamVerdict {
  const max = entitlements.maxRamMb;
  if (max == null) return { kind: 'unlimited' };
  if (requestedMb == null) return { kind: 'unknown' };
  if (!(requestedMb > 0)) return { kind: 'uncapped', maxMb: max };
  const left = Math.max(0, max - usage.ramMb);
  if (requestedMb > left) return { kind: 'over', neededMb: requestedMb, leftMb: left, maxMb: max };
  return { kind: 'fits', afterMb: usage.ramMb + requestedMb, maxMb: max };
}

/** "2 of 5", or "2" with no ceiling. */
export function countOf(used: number, max: number | null): string {
  return max == null ? String(used) : `${used} of ${max}`;
}
