import { describe, it, expect } from 'vitest';
import { can, permissionsFor, ROLE_PERMISSIONS, type ServerPermission } from './permissions';

// This table mirrors the orchestrator's access.ts. These tests are what keep the
// two from drifting silently — if the server-side matrix changes and this one
// doesn't, the panel starts offering actions that come back 403.

describe('the panel permission matrix', () => {
  it('lets a viewer look but not touch', () => {
    expect(can('viewer', 'server.logs')).toBe(true);
    expect(can('viewer', 'control.start')).toBe(false);
    expect(can('viewer', 'file.read')).toBe(false);
  });

  it('lets an operator run the server but not read or reshare it', () => {
    expect(can('operator', 'control.restart')).toBe(true);
    expect(can('operator', 'console.connect')).toBe(true);
    expect(can('operator', 'file.read')).toBe(true);
    expect(can('operator', 'file.write')).toBe(false);
    expect(can('operator', 'backup.manage')).toBe(false);
    expect(can('operator', 'subuser.manage')).toBe(false);
  });

  it('stops a server admin short of deleting the server', () => {
    expect(can('admin', 'subuser.manage')).toBe(true);
    expect(can('admin', 'server.delete')).toBe(false);
    expect(can('owner', 'server.delete')).toBe(true);
  });

  it('keeps every role a superset of the weaker ones', () => {
    const order = ['viewer', 'operator', 'admin', 'owner'] as const;
    for (let i = 1; i < order.length; i += 1) {
      for (const permission of ROLE_PERMISSIONS[order[i - 1]]) {
        expect(ROLE_PERMISSIONS[order[i]]).toContain(permission);
      }
    }
  });

  it('assumes full access when no role is known', () => {
    // Older responses carry no role. Wrongly showing a button costs a clear 403;
    // wrongly hiding one leaves an owner with no way to act on their own server.
    expect(can(undefined, 'server.delete')).toBe(true);
    expect(can(null, 'file.write')).toBe(true);
  });

  it('refuses an unrecognised permission rather than allowing it', () => {
    expect(can('owner', 'server.selfdestruct' as ServerPermission)).toBe(false);
  });

  it('binds to a role for gating a screen', () => {
    const allows = permissionsFor('operator');
    expect(allows('control.stop')).toBe(true);
    expect(allows('file.write')).toBe(false);
  });
});
