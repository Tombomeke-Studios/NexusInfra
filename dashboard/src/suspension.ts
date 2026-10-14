import type { DeploymentStatus } from './api';

// A server billing stopped for lack of credit (#380) — hosted edition only. In a
// community build this module is aliased to suspension.stub.ts (vite.config.ts):
// nothing there is ever suspended, and the words below belong to billing.
//
// The Orchestrator records the suspension with the server and clears it when it
// next starts, so this reads a field rather than guessing from the audit trail.

interface Suspendable {
  status: DeploymentStatus;
  suspendedAt?: string | null;
  suspendedReason?: string | null;
  role?: string;
}

/** Stopped by billing and not started since. A server on its way back up is not. */
export function isSuspended(d: Suspendable): boolean {
  return Boolean(d.suspendedAt) && d.status !== 'running' && d.status !== 'pending';
}

/** Why it stopped and what to do about it — or null when it is not suspended. */
export function suspensionNote(d: Suspendable): string | null {
  if (!isSuspended(d)) return null;
  const why = d.suspendedReason ? ` (${d.suspendedReason})` : '';
  // No role means the caller's own server (an older response, or the owner).
  if (!d.role || d.role === 'owner') {
    return `Stopped by billing because your account ran out of credit${why}. Top up on the Billing page, then start it again.`;
  }
  return `Stopped by billing because its owner's account ran out of credit${why}. It can be started again once they top up.`;
}
