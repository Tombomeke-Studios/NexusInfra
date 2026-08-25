import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';
import {
  canSelfRegister,
  createUserService,
  hashPassword,
  isValidEmail,
  normalizeEmail,
  passwordProblem,
  toPublicUser,
  UNUSABLE_PASSWORD_HASH,
  verifyPassword,
  type UserService,
} from './users.js';

describe('password handling', () => {
  it('verifies a password against its own hash', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('never verifies against the unusable hash the backfill seeds', async () => {
    // Servers created before accounts existed got an owner row that must not be
    // signable-in — including with the sentinel itself.
    expect(await verifyPassword(UNUSABLE_PASSWORD_HASH, UNUSABLE_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('', UNUSABLE_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('anything', UNUSABLE_PASSWORD_HASH)).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await verifyPassword('anything', 'not-a-bcrypt-digest')).toBe(false);
  });

  it('rejects passwords that are missing or too short', () => {
    expect(passwordProblem(undefined)).toMatch(/required/);
    expect(passwordProblem('')).toMatch(/required/);
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('longenough')).toBeNull();
  });
});

describe('email handling', () => {
  it('normalises case and surrounding space', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('accepts real addresses and the @local form the backfill generates', () => {
    expect(isValidEmail('ada@example.com')).toBe(true);
    expect(isValidEmail('admin@local')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('missing@tld')).toBe(false);
  });
});

describe('canSelfRegister', () => {
  it('is open in hosted, where customers sign themselves up', () => {
    expect(canSelfRegister('hosted')).toBe(true);
  });

  it('is closed in community, where an admin creates the accounts', () => {
    expect(canSelfRegister('community')).toBe(false);
  });
});

describe('UserService', () => {
  let repo: InMemoryRepository;
  let users: UserService;

  beforeEach(() => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
  });

  it('registers an account and signs in with it', async () => {
    const result = await users.register({ email: 'Ada@Example.com', password: 'lovelace1' });
    expect(result.ok).toBe(true);
    expect(await users.authenticate('ada@example.com', 'lovelace1')).not.toBeNull();
    expect(await users.authenticate('ada@example.com', 'nope')).toBeNull();
  });

  it('stores the email normalised so case never splits an identity', async () => {
    await users.register({ email: 'Ada@Example.com', password: 'lovelace1' });
    expect(await users.authenticate('ADA@EXAMPLE.COM', 'lovelace1')).not.toBeNull();
  });

  it('defaults the display name to the local part and the role to user', async () => {
    const result = await users.register({ email: 'ada@example.com', password: 'lovelace1' });
    if (!result.ok) throw new Error('expected registration to succeed');
    expect(toPublicUser(result.user)).toMatchObject({ displayName: 'ada', platformRole: 'user' });
  });

  it('refuses a duplicate email with 409', async () => {
    await users.register({ email: 'ada@example.com', password: 'lovelace1' });
    const again = await users.register({ email: 'ada@example.com', password: 'different1' });
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses an invalid email or a weak password with 400', async () => {
    expect(await users.register({ email: 'nope', password: 'lovelace1' })).toMatchObject({ ok: false, status: 400 });
    expect(await users.register({ email: 'ada@example.com', password: 'x' })).toMatchObject({ ok: false, status: 400 });
  });

  it('never exposes the password hash on the public shape', async () => {
    const result = await users.register({ email: 'ada@example.com', password: 'lovelace1' });
    if (!result.ok) throw new Error('expected registration to succeed');
    expect(Object.keys(toPublicUser(result.user))).not.toContain('passwordHash');
  });

  it('authenticates by legacy username as well as email', async () => {
    // The backfill turns the old stub login `admin` into admin@local; signing in
    // as `admin` must keep working.
    await repo.createUser({ id: 'admin', email: 'admin@local', displayName: 'admin', passwordHash: await hashPassword('admin123!'), platformRole: 'owner' });
    expect(await users.authenticate('admin', 'admin123!')).not.toBeNull();
  });

  describe('changePassword', () => {
    it('requires the current password', async () => {
      const created = await users.register({ email: 'ada@example.com', password: 'lovelace1' });
      if (!created.ok) throw new Error('expected registration to succeed');
      expect(await users.changePassword(created.user.id, 'wrong', 'newpassword1')).toMatchObject({ ok: false, status: 401 });
      expect(await users.changePassword(created.user.id, 'lovelace1', 'newpassword1')).toMatchObject({ ok: true });
      expect(await users.authenticate('ada@example.com', 'newpassword1')).not.toBeNull();
    });

    it('enforces the strength rules on the new password', async () => {
      const created = await users.register({ email: 'ada@example.com', password: 'lovelace1' });
      if (!created.ok) throw new Error('expected registration to succeed');
      expect(await users.changePassword(created.user.id, 'lovelace1', 'x')).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe('bootstrapOwner', () => {
    it('creates the first owner on an empty install', async () => {
      expect(await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' })).toBe('created');
      const user = await repo.getUserByEmail('admin@local');
      expect(user?.platformRole).toBe('owner');
    });

    it('gives the backfilled owner a real password instead of a second account', async () => {
      // This is the upgrade path: the migration seeded `admin` so old servers keep
      // an owner, but with a hash that cannot sign in.
      await repo.createUser({ id: 'admin', email: 'admin@local', displayName: 'admin', passwordHash: UNUSABLE_PASSWORD_HASH, platformRole: 'owner' });

      expect(await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' })).toBe('password-set');
      expect(await repo.countUsers()).toBe(1);
      expect(await users.authenticate('admin@local', 'admin123!')).not.toBeNull();
    });

    it('never resets the password of an account that already has one', async () => {
      await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' });
      expect(await users.bootstrapOwner({ email: 'admin@local', password: 'hijacked1' })).toBe('exists');
      expect(await users.authenticate('admin@local', 'hijacked1')).toBeNull();
      expect(await users.authenticate('admin@local', 'admin123!')).not.toBeNull();
    });

    it('does not seed an owner when other accounts already exist', async () => {
      await users.register({ email: 'ada@example.com', password: 'lovelace1' });
      expect(await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' })).toBe('exists');
      expect(await repo.getUserByEmail('admin@local')).toBeNull();
    });
  });
});
