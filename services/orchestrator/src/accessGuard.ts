// The Express side of per-server authorization (#175). access.ts decides; this
// loads what it needs to decide with, and turns the answer into a status code.
//
// Mounted once for the whole `/deployments/:id` subtree, so a new route added
// under it is guarded by default rather than by remembering to guard it. It
// still has to declare which permission it needs — see `requirePermission`.

import type { NextFunction, Request, Response } from 'express';
import { principalOf } from './auth.js';
import {
  can,
  canOnTeam,
  resolveRole,
  resolveTeamRelation,
  type Permission,
  type Role,
  type TeamPermission,
  type TeamRelation,
} from './access.js';
import type { DeploymentDetail, Repository, TeamRecord } from './types.js';

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
    // A share is addressed to an email and bound to the account when that person
    // first appears (#176). Only a bound, active share grants anything — a
    // pending invitation to an address nobody has claimed must not open a door.
    const caller = await repo.getUser(principal.id);
    const share = caller ? await repo.getSubuserFor(deployment.id, caller.email) : null;
    const grant = share?.status === 'active' && share.userId === principal.id ? share : null;

    // A server may also be shared with a team (#177); membership of it grants the
    // member's team role. Where both apply, access.ts takes the stronger.
    const membership = deployment.teamId ? await repo.getTeamMember(deployment.teamId, principal.id) : null;

    const role = resolveRole({ principal, ownerId: deployment.userId, teamId: deployment.teamId, grant, membership });
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

// ---------------------------------------------------------------------------
// The same shape, for teams (#224).
//
// The team routes used to check ownership and membership by hand in every
// handler. That is exactly the pattern #175 replaced for servers: authorization
// spread across handlers is authorization that is eventually forgotten in one of
// them, and the one it is forgotten in is the one that matters.

/** What the team guard leaves on the request for the handlers behind it. */
export interface TeamRequestAccess {
  relation: TeamRelation;
  team: TeamRecord;
}

type TeamAccessRequest = Request & { teamAccess?: TeamRequestAccess };

/** The resolved team access for the current request. Throws if used before the guard. */
export function teamAccessOf(req: Request): TeamRequestAccess {
  const access = (req as TeamAccessRequest).teamAccess;
  if (!access) throw new Error('teamAccessOf called on a route that is not behind teamGuard');
  return access;
}

/**
 * Look up a team the caller has any business seeing, and how they stand to it.
 *
 * Also used where a team is named in a *body* rather than the path — attaching a
 * server to one — so that "a team you can see" means one thing everywhere.
 */
export async function teamAccessFor(
  repo: Repository,
  teamId: string,
  userId: string,
): Promise<TeamRequestAccess | null> {
  const team = await repo.getTeam(teamId);
  if (!team) return null;
  const membership = team.ownerId === userId ? null : await repo.getTeamMember(team.id, userId);
  const relation = resolveTeamRelation({ principal: { id: userId }, ownerId: team.ownerId, membership });
  return relation ? { relation, team } : null;
}

/** Resolve the caller's standing on the addressed team, or 404. */
export function teamGuard(repo: Repository) {
  return async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const access = await teamAccessFor(repo, req.params.id, principalOf(req).id);
    if (!access) {
      res.status(404).json({ error: 'team not found' });
      return;
    }
    (req as TeamAccessRequest).teamAccess = access;
    next();
  };
}

/** Require one permission on the already-resolved team. */
export function requireTeamPermission(permission: TeamPermission, refusal = 'only the team owner can do this') {
  return function check(req: Request, res: Response, next: NextFunction): void {
    const { relation } = teamAccessOf(req);
    if (!canOnTeam(relation, permission)) {
      res.status(403).json({ error: refusal });
      return;
    }
    next();
  };
}

/**
 * Require a team permission, unless the caller is acting on themselves.
 *
 * Leaving is not managing: a member may remove their own membership without
 * being able to touch anyone else's.
 */
export function requireTeamPermissionOrSelf(
  permission: TeamPermission,
  subjectOf: (req: Request) => string,
  refusal?: string,
) {
  const otherwise = requireTeamPermission(permission, refusal);
  return function check(req: Request, res: Response, next: NextFunction): void {
    if (subjectOf(req) === principalOf(req).id) {
      next();
      return;
    }
    otherwise(req, res, next);
  };
}
