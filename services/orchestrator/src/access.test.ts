import { describe, it, expect } from 'vitest';
import {
  can,
  GRANTABLE_ROLES,
  isGrantableRole,
  isRole,
  resolveRole,
  ROLE_PERMISSIONS,
  ROLES,
  strongestRole,
  type Permission,
  type Role,
} from './access.js';

const OWNER_ID = 'user-owner';
const OTHER_ID = 'user-other';

const principal = (id: string, platformRole: 'owner' | 'admin' | 'user' = 'user') => ({ id, platformRole });

describe('the permission matrix', () => {
  it('gives a viewer visibility and nothing more', () => {
    expect(can('viewer', 'server.view')).toBe(true);
    expect(can('viewer', 'server.logs')).toBe(true);
    expect(can('viewer', 'server.stats')).toBe(true);
    expect(can('viewer', 'control.start')).toBe(false);
    expect(can('viewer', 'control.stop')).toBe(false);
    expect(can('viewer', 'file.read')).toBe(false);
  });

  it('lets an operator run the server without reaching its data or its guest list', () => {
    // This is the role the whole feature exists for: "let someone else start my
    // server" without also handing over the files, backups and sharing.
    expect(can('operator', 'control.start')).toBe(true);
    expect(can('operator', 'control.stop')).toBe(true);
    expect(can('operator', 'control.restart')).toBe(true);
    expect(can('operator', 'console.connect')).toBe(true);
    expect(can('operator', 'file.read')).toBe(true);

    expect(can('operator', 'file.write')).toBe(false);
    expect(can('operator', 'backup.manage')).toBe(false);
    expect(can('operator', 'database.manage')).toBe(false);
    expect(can('operator', 'schedule.manage')).toBe(false);
    expect(can('operator', 'subuser.manage')).toBe(false);
    expect(can('operator', 'server.delete')).toBe(false);
  });

  it('lets a server admin manage everything except destroying the server', () => {
    expect(can('admin', 'file.write')).toBe(true);
    expect(can('admin', 'subuser.manage')).toBe(true);
    expect(can('admin', 'backup.manage')).toBe(true);
    expect(can('admin', 'server.delete')).toBe(false);
  });

  it('reserves deletion for the owner', () => {
    expect(can('owner', 'server.delete')).toBe(true);
  });

  it('grants no permission at all without a role', () => {
    for (const permission of ROLE_PERMISSIONS.owner) {
      expect(can(null, permission)).toBe(false);
      expect(can(undefined, permission)).toBe(false);
    }
  });

  it('keeps every role a superset of the weaker ones', () => {
    // Guards against someone adding a permission to `operator` but forgetting
    // `admin`, which would make a stronger role weaker than a lesser one.
    for (let i = 1; i < ROLES.length; i += 1) {
      const weaker = ROLE_PERMISSIONS[ROLES[i - 1]];
      const stronger = ROLE_PERMISSIONS[ROLES[i]];
      for (const permission of weaker) expect(stronger).toContain(permission);
    }
  });

  it('rejects an unknown permission rather than defaulting to allow', () => {
    expect(can('owner', 'server.selfdestruct' as Permission)).toBe(false);
  });

  it('rejects an unknown role rather than defaulting to allow', () => {
    expect(can('superuser' as Role, 'server.view')).toBe(false);
    expect(isRole('superuser')).toBe(false);
    expect(isRole('operator')).toBe(true);
  });
});

describe('strongestRole', () => {
  it('picks the most privileged of several grants', () => {
    expect(strongestRole('viewer', 'admin')).toBe('admin');
    expect(strongestRole('admin', 'viewer')).toBe('admin');
    expect(strongestRole('operator', 'viewer', 'operator')).toBe('operator');
  });

  it('ignores absent grants and returns null when there are none', () => {
    expect(strongestRole(null, 'viewer', undefined)).toBe('viewer');
    expect(strongestRole(null, undefined)).toBeNull();
  });
});

describe('resolveRole', () => {
  it('makes the account that owns a server its owner', () => {
    expect(resolveRole({ principal: principal(OWNER_ID), ownerId: OWNER_ID })).toBe('owner');
  });

  it('gives a stranger no access at all', () => {
    // null, not 'viewer' — the caller turns this into a 404 so server ids can't
    // be probed for existence.
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID })).toBeNull();
  });

  it('applies a direct share', () => {
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, grant: { role: 'operator' } })).toBe('operator');
  });

  it('applies team membership', () => {
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, membership: { role: 'admin' } })).toBe('admin');
  });

  it('takes the stronger of a direct share and a team membership', () => {
    expect(
      resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, grant: { role: 'viewer' }, membership: { role: 'admin' } })
    ).toBe('admin');
    expect(
      resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, grant: { role: 'admin' }, membership: { role: 'viewer' } })
    ).toBe('admin');
  });

  it('never lets a share confer ownership', () => {
    // Otherwise a server admin could grant deletion rights, which are the one
    // thing the owner keeps to themselves.
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, grant: { role: 'owner' } })).toBeNull();
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, membership: { role: 'owner' } })).toBeNull();
    expect(GRANTABLE_ROLES).not.toContain('owner');
    expect(isGrantableRole('owner')).toBe(false);
  });

  it('ignores a grant with a role it does not recognise', () => {
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, grant: { role: 'superuser' } })).toBeNull();
    expect(resolveRole({ principal: principal(OTHER_ID), ownerId: OWNER_ID, grant: { role: '' } })).toBeNull();
  });

  it('treats platform administrators as owners of every server', () => {
    // They already control the hosts these containers run on.
    expect(resolveRole({ principal: principal(OTHER_ID, 'admin'), ownerId: OWNER_ID })).toBe('owner');
    expect(resolveRole({ principal: principal(OTHER_ID, 'owner'), ownerId: OWNER_ID })).toBe('owner');
  });

  it('does not treat an ordinary user as an administrator', () => {
    expect(resolveRole({ principal: principal(OTHER_ID, 'user'), ownerId: OWNER_ID })).toBeNull();
  });
});
