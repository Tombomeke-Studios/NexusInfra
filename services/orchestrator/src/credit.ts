import { isHosted } from 'shared';
import { bridgeFetch } from './bridge.js';

// Prepaid credit, enforced where servers are started (#365). The Billing Bridge
// knows what an account has left; the Orchestrator is the one that starts
// things, so it asks first.
//
// Measured against the server's **owner**, whoever presses Start — the same rule
// as plan entitlements (#297): an administrator starting somebody's server spends
// that person's credit.

/** An account's standing, as the Billing Bridge reports it. */
export interface Standing {
  balance: number;
  accrued: number;
  available: number;
  freeHoursLeft: number;
  canRun: boolean;
  currency: string;
  /** Hours the credit lasts at the running servers' rate (#379); null with nothing running. */
  hoursLeft: number | null;
  /** Whether that is under the warning threshold. */
  runsLow: boolean;
}

/** "about 21 hours", "about 3 days" — how long, the way a person reads it at a glance (#379). */
export function runwayText(hours: number): string {
  if (hours < 1) return 'less than an hour';
  if (hours < 48) {
    const h = Math.round(hours);
    return `about ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `about ${Math.round(hours / 24)} days`;
}

/** The one line of a `credit.low` notification (#379): how long, and what to do about it. */
export function creditLowSummary(p: { hoursLeft: number; available: number; currency: string }): string {
  return `Your credit (${money(p.available, p.currency)}) runs out in ${runwayText(p.hoursLeft)} at the rate your servers are using it — top up on the Billing page, or your servers will be stopped`;
}

const money = (amount: number, currency: string) => `${currency === 'EUR' ? '€' : `${currency} `}${amount.toFixed(2)}`;

/**
 * Why this account may not start a server, or null. `null` standing means no
 * rule applies: the community edition, or a bridge that could not be asked.
 */
export function creditProblem(standing: Standing | null): string | null {
  if (!standing || standing.canRun) return null;
  if (standing.available < 0) {
    return `this account owes ${money(-standing.available, standing.currency)} for what its servers have already used — top up on the Billing page to start servers again`;
  }
  return 'this account has no credit left — top up on the Billing page to start a server';
}

/**
 * Ask the Billing Bridge. Fails open, like the quota and entitlement checks: a
 * billing outage must not stop people running servers — and it is logged, so
 * running without the check is never silent.
 */
export async function fetchStanding(userId: string): Promise<Standing | null> {
  if (!isHosted()) return null;
  try {
    const r = await bridgeFetch(`/billing/${encodeURIComponent(userId)}/standing`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Standing;
  } catch (err) {
    console.warn(`[Orchestrator] credit standing unavailable, not enforced: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
