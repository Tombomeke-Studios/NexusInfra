// User accounts (#174) — the panel's local identity.
//
// NexusInfra owns its own credentials rather than delegating to FinVault: the
// community edition has no FinVault at all, and the hosted edition needs to work
// before the shared-JWT integration (#17) lands. auth.ts wraps this behind an
// AuthProvider seam so a FinVault-issued token can replace the local check later
// without any caller changing.
//
// Everything here that can be pure is pure, so the rules (what a valid password
// is, who may register, how a role is resolved) are tested without a database.

import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { isHosted, type Edition } from 'shared';
import type { CreateUserInput, Repository, UserRecord } from './types.js';

/** Panel-wide standing, distinct from the per-server role a user holds (#175). */
export type PlatformRole = 'owner' | 'admin' | 'user';

export const PLATFORM_ROLES: readonly PlatformRole[] = ['owner', 'admin', 'user'];

/**
 * Marks an account that exists to own things but cannot sign in. It is not a
 * valid bcrypt digest, so `verifyPassword` can never match it whatever is
 * supplied. The backfill migration seeds pre-accounts servers with it.
 */
export const UNUSABLE_PASSWORD_HASH = '!';

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

/** Cost of hashing is deliberate; keep it off the hot path. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** False for any unusable/malformed hash rather than throwing. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || hash === UNUSABLE_PASSWORD_HASH) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || /^[^\s@]+@local$/.test(email.trim());
}

/** Human-readable reason a password is unacceptable, or null when it's fine. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'a password is required';
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

/**
 * Whether anyone may create their own account.
 *
 * Hosted is a hosting provider: customers sign themselves up. Community is
 * somebody's own machine, where an open registration form on a panel that
 * controls Docker would be a liability — there, an admin creates the accounts.
 */
export function canSelfRegister(edition?: Edition): boolean {
  return isHosted(edition);
}

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

/** What a user looks like over the wire — never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  platformRole: PlatformRole;
  createdAt: string;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    platformRole: isPlatformRole(user.platformRole) ? user.platformRole : 'user',
    createdAt: user.createdAt,
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string;
  platformRole?: PlatformRole;
}

export type RegisterResult = { ok: true; user: UserRecord } | { ok: false; status: number; error: string };

export interface UserService {
  register(input: RegisterInput): Promise<RegisterResult>;
  /** Resolve a login by email or by legacy username/id; null when it fails. */
  authenticate(identifier: string, password: string): Promise<UserRecord | null>;
  changePassword(userId: string, current: string, next: string): Promise<RegisterResult>;
  /** Seed or repair the first administrator. Safe to call on every start. */
  bootstrapOwner(input: { email: string; password: string; displayName?: string }): Promise<'created' | 'password-set' | 'exists'>;
}

export function createUserService(deps: { repo: Repository }): UserService {
  const { repo } = deps;

  async function register(input: RegisterInput): Promise<RegisterResult> {
    const email = normalizeEmail(input.email ?? '');
    if (!isValidEmail(email)) return { ok: false, status: 400, error: 'a valid email is required' };
    const problem = passwordProblem(input.password);
    if (problem) return { ok: false, status: 400, error: problem };
    if (await repo.getUserByEmail(email)) return { ok: false, status: 409, error: 'an account with that email already exists' };

    const user = await repo.createUser({
      id: randomUUID(),
      email,
      displayName: input.displayName?.trim() || email.split('@')[0],
      passwordHash: await hashPassword(input.password),
      platformRole: input.platformRole ?? 'user',
    } satisfies CreateUserInput);
    return { ok: true, user };
  }

  async function authenticate(identifier: string, password: string): Promise<UserRecord | null> {
    if (typeof identifier !== 'string' || typeof password !== 'string') return null;
    // Accept the legacy username too, so `admin` keeps working after the
    // backfill turned it into admin@local.
    const user = (await repo.getUserByEmail(normalizeEmail(identifier))) ?? (await repo.getUser(identifier.trim()));
    if (!user) return null;
    return (await verifyPassword(password, user.passwordHash)) ? user : null;
  }

  async function changePassword(userId: string, current: string, next: string): Promise<RegisterResult> {
    const user = await repo.getUser(userId);
    if (!user) return { ok: false, status: 404, error: 'user not found' };
    if (!(await verifyPassword(current, user.passwordHash))) return { ok: false, status: 401, error: 'current password is incorrect' };
    const problem = passwordProblem(next);
    if (problem) return { ok: false, status: 400, error: problem };
    const updated = await repo.setUserPassword(userId, await hashPassword(next));
    return updated ? { ok: true, user: updated } : { ok: false, status: 404, error: 'user not found' };
  }

  async function bootstrapOwner(input: { email: string; password: string; displayName?: string }): Promise<'created' | 'password-set' | 'exists'> {
    const email = normalizeEmail(input.email);
    const existing = await repo.getUserByEmail(email);

    // The backfill seeds the pre-accounts owner with an unusable hash so that old
    // servers keep an owner. Give it a real password rather than creating a
    // second account, which would orphan those servers.
    if (existing) {
      if (existing.passwordHash !== UNUSABLE_PASSWORD_HASH) return 'exists';
      await repo.setUserPassword(existing.id, await hashPassword(input.password));
      return 'password-set';
    }
    if ((await repo.countUsers()) > 0) return 'exists';

    await repo.createUser({
      id: randomUUID(),
      email,
      displayName: input.displayName?.trim() || 'Administrator',
      passwordHash: await hashPassword(input.password),
      platformRole: 'owner',
    });
    return 'created';
  }

  return { register, authenticate, changePassword, bootstrapOwner };
}
