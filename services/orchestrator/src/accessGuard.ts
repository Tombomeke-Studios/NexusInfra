// The Express side of per-server authorization (#175). access.ts decides; this
// loads what it needs to decide with, and turns the answer into a status code.
//
// Mounted once for the whole `/deployments/:id` subtree, so a new route added
// under it is guarded by default rather than by remembering to guard it. It
// still has to declare which permission it needs — see `requirePermission`.

import type { NextFunction, Request, Response } from 'express';
import { principalOf } from './auth.js';
import { can, resolveRole, type Permission, type Role } from './access.js';
import type { DeploymentDetail, Repository } from './types.js';

/** What the guard leaves on the request for the handlers behind it. */
export interface RequestAccess {
  role: Role;
  deployment: DeploymentDetail;
}

type AccessRequest = Request & { access?: RequestAccess };

/** The resolved access for the current request. Throws if used before the guard. */
export function accessOf(req: Request): RequestAccess {
  const access = (req as AccessRequest).access;
  if (!access) throw new Error('accessOf called on a route that is not behind accessGuard');
  return access;
}

/**
 * Resolve the caller's role on the addressed server, or refuse.
 *
 * A caller with no access gets **404, not 403**. A 403 would confirm the server
 * exists, letting anyone walk ids to discover what other people run — and the
 * distinction is invisible to a legitimate user, who sees 404 either way.
 */
export function accessGuard(repo: Repository) {
  return async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const deployment = await repo.getDeployment(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'deployment not found' });
      return;
    }

    const principal = principalOf(req);
    // Shares are addressed by email until they are bound to accounts (#176), so
    // the caller's own address is what matches them.
    const caller = await repo.getUser(principal.id);
    const grant = caller ? await repo.getSubuserFor(deployment.id, caller.email) : null;

    const role = resolveRole({ principal, ownerId: deployment.userId, grant });
    if (!role) {
      res.status(404).json({ error: 'deployment not found' });
      return;
    }

    (req as AccessRequest).access = { role, deployment };
    next();
  };
}

/**
 * Require one permission on the already-resolved server.
 *
 * 403 here is deliberate and safe: the guard has established that the caller may
 * see this server at all, so refusing a specific action reveals nothing new.
 */
export function requirePermission(permission: Permission) {
  return function check(req: Request, res: Response, next: NextFunction): void {
    const { role } = accessOf(req);
    if (!can(role, permission)) {
      res.status(403).json({ error: `your role on this server (${role}) cannot perform this action` });
      return;
    }
    next();
  };
}
