// The panel's view of the server permission matrix (#178).
//
// This mirrors `services/orchestrator/src/access.ts`, which remains the only
// thing that actually enforces anything. The copy exists so the panel can avoid
// *offering* an action that would come back 403 — a disabled button is a better
// answer than an error toast. If the two ever disagree the server wins, and the
// user sees a refusal rather than a hole.

export type ServerRole = 'owner' | 'admin' | 'operator' | 'viewer';

export type ServerPermission =
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
  | 'server.delete';

const VIEWER: ServerPermission[] = ['server.view', 'server.logs', 'server.stats'];

const OPERATOR: ServerPermission[] = [
  ...VIEWER,
  'control.start',
  'control.stop',
  'control.restart',
  'console.exec',
  'console.connect',
  'file.read',
];

const ADMIN: ServerPermission[] = [...OPERATOR, 'file.write', 'database.manage', 'backup.manage', 'schedule.manage', 'subuser.manage', 'server.edit'];

const OWNER: ServerPermission[] = [...ADMIN, 'server.delete'];

export const ROLE_PERMISSIONS: Record<ServerRole, ServerPermission[]> = {
  viewer: VIEWER,
  operator: OPERATOR,
  admin: ADMIN,
  owner: OWNER,
};

export const ROLE_LABELS: Record<ServerRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};

/**
 * Whether `role` may do `permission`.
 *
 * An **absent** role is treated as owner: the panel talks to installations that
 * predate roles being returned, and a viewer who is wrongly shown a button gets
 * a clear 403, whereas an owner wrongly shown a read-only panel has no recourse.
 */
export function can(role: ServerRole | undefined | null, permission: ServerPermission): boolean {
  if (!role) return true;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Bind `can` to one role, for gating a screen's controls. */
export function permissionsFor(role: ServerRole | undefined | null) {
  return (permission: ServerPermission) => can(role, permission);
}
