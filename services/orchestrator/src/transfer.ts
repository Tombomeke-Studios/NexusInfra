// Handing a server to another account (#230).
//
// Ownership used to be fixed at creation, which quietly orphaned servers: when
// the owner's account went away, nobody could ever hold `owner` on them again,
// so nobody could delete them or manage who else had access. A server-level
// admin cannot do either — that is the whole point of the role — so the server
// stayed in limbo with no way out.
//
// This module is the decision, kept pure: given who owns the server now, who is
// to own it, and what the outgoing owner should keep, it produces a plan or a
// refusal. The plumbing that applies the plan in one transaction lives in the
// repository, and the route in api.ts does neither.

import { isGrantableRole, type GrantableRole } from './access.js';

export interface TransferPlan {
  newOwnerId: string;
  /**
   * The share to write for the outgoing owner, or null when they walk away with
   * nothing. Bound to their account rather than left pending: they demonstrably
   * have one, so an invitation addressed to their email would be a weaker grant
   * for no reason.
   */
  retainedShare: { email: string; userId: string; role: GrantableRole } | null;
  /**
   * A share the incoming owner already held, now redundant. Left in place it
   * would show the new owner as a subuser of their own server, and a later
   * revoke of it would look like it should take their access away.
   */
  dropShareId: string | null;
  auditMessage: string;
}

export type TransferResult =
  | { ok: true; plan: TransferPlan }
  | { ok: false; status: number; error: string };

export interface TransferInput {
  /** The account that owns the server today, or null if it no longer exists. */
  currentOwner: { id: string; email: string } | null;
  /** The account it is being handed to. Must exist — see below. */
  newOwner: { id: string; email: string };
  /** What the outgoing owner keeps, straight from the request body. */
  retainRole?: unknown;
  /** A share the incoming owner already holds on this server, if any. */
  existingShareForNewOwner?: { id: string } | null;
}

export function planTransfer(input: TransferInput): TransferResult {
  const { currentOwner, newOwner, retainRole, existingShareForNewOwner } = input;

  if (currentOwner && currentOwner.id === newOwner.id) {
    return { ok: false, status: 400, error: 'that account already owns this server' };
  }

  const keeps = retainRole !== undefined && retainRole !== null && retainRole !== '';
  if (keeps && !isGrantableRole(retainRole)) {
    return { ok: false, status: 400, error: 'retainRole must be admin, operator, viewer or null' };
  }

  // Ownership is the one role a share cannot confer, so the outgoing owner can
  // only ever step *down* to a grantable role — never keep what they had.
  if (keeps && !currentOwner) {
    // The orphan case this feature exists for: there is no account left to grant
    // anything to. Saying so is better than silently dropping the request.
    return { ok: false, status: 409, error: 'the previous owner no longer has an account to keep a role on' };
  }

  const retainedShare =
    keeps && currentOwner
      ? { email: currentOwner.email, userId: currentOwner.id, role: retainRole as GrantableRole }
      : null;

  const from = currentOwner ? currentOwner.email : 'an account that no longer exists';
  const kept = retainedShare ? `previous owner kept ${retainedShare.role}` : 'previous owner lost access';

  return {
    ok: true,
    plan: {
      newOwnerId: newOwner.id,
      retainedShare,
      dropShareId: existingShareForNewOwner?.id ?? null,
      auditMessage: `ownership transferred from ${from} to ${newOwner.email}; ${kept}`,
    },
  };
}
