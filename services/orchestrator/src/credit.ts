import { isHosted } from 'shared';

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
export async function fetchStanding(bridgeUrl: string, userId: string): Promise<Standing | null> {
  if (!isHosted()) return null;
  try {
    const r = await fetch(`${bridgeUrl}/billing/${encodeURIComponent(userId)}/standing`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Standing;
  } catch (err) {
    console.warn(`[Orchestrator] credit standing unavailable, not enforced: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
