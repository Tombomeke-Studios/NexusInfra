// Per-server authorization (#175) — who may do what to one server.
//
// This is the security core of sharing, so it is deliberately pure: no Express,
// no database, no clock. Given a caller and the grants that apply to them, it
// answers with a role; given a role and an action, it answers yes or no. The
// plumbing that loads those grants lives in accessGuard.ts.
//
// Two different notions of "role" meet here, and conflating them is the mistake
// this file exists to prevent:
//
//   platform role  — panel-wide standing (owner/admin/user), carried on the JWT.
//                    It says whether you administer the *installation*.
//   server role    — what you may do to *one* server, resolved per request from
//                    ownership, a direct share, or team membership. Never on the
//                    token: a share can be revoked between two requests, and a
//                    token minted before the revocation must not outlive it.

import type { PlatformRole } from './users.js';

/** Ordered least to most privileged; every role includes the ones before it. */
export type Role = 'viewer' | 'operator' | 'admin' | 'owner';

export const ROLES: readonly Role[] = ['viewer', 'operator', 'admin', 'owner'];

/** Roles that can be *granted* to someone else. Ownership is not a grant. */
export type GrantableRole = Exclude<Role, 'owner'>;

export const GRANTABLE_ROLES: readonly GrantableRole[] = ['viewer', 'operator', 'admin'];

export type Permission =
  | 'server.view'
  | 'server.logs'
  | 'server.stats'
  | 'control.start'
  | 'control.stop'
  | 'control.restart'
  | 'console.exec'
  | 'console.connect'
  | 'file.read'
  | 'file.write'
  | 'database.manage'
  | 'backup.manage'
  | 'schedule.manage'
  | 'subuser.manage'
  | 'server.edit'
  | 'server.transfer'
  | 'server.delete';

// Each tier adds to the one below it, so a role can never accidentally be
// granted less than a weaker role.
const VIEWER: readonly Permission[] = ['server.view', 'server.logs', 'server.stats'];

const OPERATOR: readonly Permission[] = [
  ...VIEWER,
  // The point of the operator role: someone you trust to keep the server
  // running, without handing them the data or the guest list.
  'control.start',
  'control.stop',
  'control.restart',
  'console.exec',
  'console.connect',
  'file.read',
];

const ADMIN: readonly Permission[] = [
  ...OPERATOR,
  'file.write',
  'database.manage',
  'backup.manage',
  'schedule.manage',
  'subuser.manage',
  // Changing image, ports, environment or limits is a configuration change, not a
  // destructive one — it sits with the server admin, next to the other management
  // permissions (#220). Deleting still does not.
  'server.edit',
];

// Deleting a server destroys its data and its backups, so it stays with the
// owner (or a platform administrator) even for a server-level admin. So does
// handing the server to someone else (#230) — a server admin who could transfer
// would be able to give themselves the one thing their role withholds.
const OWNER: readonly Permission[] = [...ADMIN, 'server.transfer', 'server.delete'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  operator: OPERATOR,
  admin: ADMIN,
  owner: OWNER,
};

/** Whether `role` may perform `permission`. A null role is no access at all. */
export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isGrantableRole(value: unknown): value is GrantableRole {
  return typeof value === 'string' && (GRANTABLE_ROLES as readonly string[]).includes(value);
}

/** Higher wins when several grants apply to the same person. */
export function strongestRole(...roles: Array<Role | null | undefined>): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (!role) continue;
    if (!best || ROLES.indexOf(role) > ROLES.indexOf(best)) best = role;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Teams (#177), authorized the same way (#224)
//
// A team has no role ladder of its own: you either run it or you are in it. The
// role stored on a membership is a *server* role — what that member gets on the
// servers the team holds — and says nothing about the team itself.

/** How the caller stands to one team. */
export type TeamRelation = 'member' | 'owner';

export type TeamPermission = 'team.view' | 'team.members.manage' | 'team.delete';

const TEAM_MEMBER: readonly TeamPermission[] = ['team.view'];

// Membership grants access to every server the team holds, present and future,
// so adding someone is effectively granting on the owner's behalf — it stays
// with the person who created the team, as does dissolving it.
const TEAM_OWNER: readonly TeamPermission[] = [...TEAM_MEMBER, 'team.members.manage', 'team.delete'];

export const TEAM_PERMISSIONS: Record<TeamRelation, readonly TeamPermission[]> = {
  member: TEAM_MEMBER,
  owner: TEAM_OWNER,
};

/** Whether `relation` may perform `permission`. No relation is no access at all. */
export function canOnTeam(relation: TeamRelation | null | undefined, permission: TeamPermission): boolean {
  if (!relation) return false;
  return TEAM_PERMISSIONS[relation]?.includes(permission) ?? false;
}

export interface TeamAccessInput {
  principal: { id: string };
  /** The account that created the team. */
  ownerId: string;
  /** The caller's membership of it, if any. */
  membership?: { role: string } | null;
}

/**
 * The caller's standing on one team, or **null** when they have none.
 *
 * As with servers, null must become a 404 rather than a 403 — otherwise team ids
 * turn into a directory of who works with whom.
 *
 * Unlike `resolveRole`, a platform administrator gets nothing here. Administering
 * the installation means reaching every *server*; a team is a private grouping of
 * people, and there is no operation on one that an admin cannot already perform
 * directly on the servers it holds.
 */
export function resolveTeamRelation(input: TeamAccessInput): TeamRelation | null {
  if (input.principal.id === input.ownerId) return 'owner';
  return input.membership ? 'member' : null;
}

export interface AccessInput {
  /** The signed-in caller. */
  principal: { id: string; platformRole: PlatformRole };
  /** The account that owns the server. */
  ownerId: string;
  /** The team this server is shared with, if any (#177). */
  teamId?: string | null;
  /** A direct share on this server, if the caller has one. */
  grant?: { role: string } | null;
  /** The caller's membership of the team this server is shared with, if any (#177). */
  membership?: { role: string } | null;
}

/**
 * The caller's role on one server, or **null** when they have no access.
 *
 * Callers must translate null into a 404 rather than a 403: a 403 confirms the
 * server exists, which turns any id into an oracle for what other people run.
 */
export function resolveRole(input: AccessInput): Role | null {
  const { principal, ownerId, grant, membership } = input;

  // Whoever administers the installation can already reach the Docker socket
  // through the node agents; pretending otherwise here would be theatre.
  if (principal.platformRole === 'owner' || principal.platformRole === 'admin') return 'owner';

  if (principal.id === ownerId) return 'owner';

  // Only ever *grantable* roles from a share — a grant must not confer ownership,
  // which would let a server admin hand out deletion rights.
  const granted = isGrantableRole(grant?.role) ? grant!.role : null;
  const viaTeam = isGrantableRole(membership?.role) ? membership!.role : null;
  return strongestRole(granted, viaTeam);
}
