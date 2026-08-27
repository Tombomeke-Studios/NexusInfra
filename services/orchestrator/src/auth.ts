import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { canSelfRegister, isPlatformRole, toPublicUser, type PlatformRole, type UserService } from './users.js';
import type { ApiTokenRecord, Repository } from './types.js';
import { createLoginLimiter, loginKeys, type LoginLimiter } from './loginLimiter.js';
import {
  formatScopes,
  generateApiToken,
  hashApiToken,
  isApiScope,
  isApiTokenSecret,
  isExpired,
  parseScopes,
  scopeAllowsAdmin,
  scopeAllowsMethod,
  type ApiScope,
} from './apiTokens.js';

// Authentication for the panel (#174).
//
// Identity is local: the Orchestrator holds the credential and signs the JWT.
// The AuthProvider seam below exists so the eventual FinVault-issued token (#17)
// can replace the local check without any caller changing — routes and
// middleware only ever see a Principal.
//
// Authorization is a separate concern and lives in access.ts (#175): a valid
// token says *who* you are, never *what you may do*.

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const TOKEN_TTL = '12h';

/** Who a request is running as. `platformRole` is panel-wide standing. */
export interface Principal {
  id: string;
  platformRole: PlatformRole;
  /**
   * Which session this request belongs to (#227).
   *
   * Optional only because a token minted before sessions existed has none; such a
   * token is rejected by `createRequireAuth`, which is the point — a session that
   * cannot be found is a login that can no longer be ended, and an unrevocable
   * token is exactly what this replaced.
   */
  sessionId?: string;
  /**
   * Set when the caller authenticated with an API token rather than a password
   * login (#228). Its presence is what tells the scope guard there is anything
   * to narrow: a person signing in has no scopes and is limited only by their
   * roles.
   */
  tokenId?: string;
  /** What this token may do, always a subset of what the account may do (#228). */
  scopes?: ApiScope[];
}

/** Pluggable credential check — LocalAuthProvider today, FinVault later (#17). */
export interface AuthProvider {
  login(identifier: string, password: string): Promise<Principal | null>;
}

export function createLocalAuthProvider(users: UserService): AuthProvider {
  return {
    async login(identifier, password) {
      const user = await users.authenticate(identifier, password);
      if (!user) return null;
      return { id: user.id, platformRole: isPlatformRole(user.platformRole) ? user.platformRole : 'user' };
    },
  };
}

export function signToken(principal: Principal): string {
  return jwt.sign({ sub: principal.id, role: principal.platformRole, sid: principal.sessionId }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

/** Decode and validate a token into its Principal; throws when it isn't valid. */
export function verifyToken(token: string): Principal {
  const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string; role?: string; sid?: string };
  if (!decoded.sub) throw new Error('token missing subject');
  return {
    id: decoded.sub,
    platformRole: isPlatformRole(decoded.role) ? decoded.role : 'user',
    sessionId: decoded.sid,
  };
}

/** The request shape once `requireAuth` has run. */
export type AuthedRequest = Request & { principal?: Principal; userId?: string };

/**
 * Requires a valid Bearer token and attaches the caller.
 *
 * There is deliberately no anonymous fallback: before accounts existed an
 * unauthenticated request silently acted as a shared `dev-user`, which would now
 * mean acting as the owner of that user's servers.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    const principal = verifyToken(token);
    const authed = req as AuthedRequest;
    authed.principal = principal;
    authed.userId = principal.id; // compatibility alias for existing handlers
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

/** How often a session's last-seen timestamp is written, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * `requireAuth`, plus the check that makes a token revocable (#227).
 *
 * A valid signature is no longer enough: the session the token names has to still
 * exist. Without this a JWT stayed usable until it expired no matter what happened
 * to the account behind it — changing your password, or removing someone, did not
 * end their session, which made "log out everywhere" a claim the panel could not
 * honour.
 *
 * The cost is a database read per authenticated request. That is the price of the
 * answer being true, and it is one indexed lookup.
 */
export function createRequireAuth(deps: { repo: Repository }) {
  return async function requireAuthWithSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }

    // An API token is recognised by its prefix rather than by trying to verify it
    // as a JWT and treating the failure as a hint (#228).
    if (isApiTokenSecret(token)) {
      const principal = await authenticateApiToken(deps.repo, token);
      if (!principal) {
        res.status(401).json({ error: 'invalid or expired API token' });
        return;
      }
      const authed = req as AuthedRequest;
      authed.principal = principal;
      authed.userId = principal.id;
      next();
      return;
    }

    let principal: Principal;
    try {
      principal = verifyToken(token);
    } catch {
      res.status(401).json({ error: 'invalid or expired token' });
      return;
    }

    // A token with no session predates sessions, or was minted by something that
    // does not create them. Either way it cannot be revoked, so it is not honoured.
    if (!principal.sessionId) {
      res.status(401).json({ error: 'invalid or expired token' });
      return;
    }

    const session = await deps.repo.getSession(principal.sessionId);
    if (!session || session.userId !== principal.id) {
      res.status(401).json({ error: 'this session has ended; sign in again' });
      return;
    }

    // Written at most once a minute: "last seen" only needs to be good enough to
    // recognise a session in a list, and a write per request is a real cost.
    const now = Date.now();
    if (now - new Date(session.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
      await deps.repo.touchSession(session.id, new Date(now).toISOString());
    }

    const authed = req as AuthedRequest;
    authed.principal = principal;
    authed.userId = principal.id;
    next();
  };
}

/** How often a token's last-used timestamp is written, for the same reason as sessions. */
const TOKEN_TOUCH_INTERVAL_MS = 60_000;

/**
 * Resolve an API token into the account it belongs to (#228), or null.
 *
 * Looked up by digest, because the secret itself is never stored — a database
 * that leaks yields nothing that can be presented at the door.
 */
export async function authenticateApiToken(repo: Repository, secret: string): Promise<Principal | null> {
  const record = await repo.getApiTokenByHash(hashApiToken(secret));
  if (!record) return null;
  // An expiry makes a token die without anyone having to remember to delete it.
  if (isExpired(record.expiresAt)) return null;

  const user = await repo.getUser(record.userId);
  // The account is gone, so the token is too — the same rule that makes a session
  // stop working when its account does (#227).
  if (!user) return null;

  const now = Date.now();
  if (!record.lastUsedAt || now - new Date(record.lastUsedAt).getTime() > TOKEN_TOUCH_INTERVAL_MS) {
    await repo.touchApiToken(record.id, new Date(now).toISOString());
  }

  return {
    id: user.id,
    platformRole: isPlatformRole(user.platformRole) ? user.platformRole : 'user',
    tokenId: record.id,
    scopes: parseScopes(record.scopes),
  };
}

/**
 * Hold API tokens to their scopes (#228). Mount once, after authentication.
 *
 * Scoping is by method, not by a table of paths: a path table is a second
 * description of the API that has to be kept in step with the first, and the day
 * it falls behind is the day a new route is unscoped — silently, and only for
 * the callers who use tokens. Every route is on one side of the safe/unsafe line
 * already, including the ones nobody has written yet.
 *
 * A person signing in with a password has no scopes and is unaffected.
 */
export function requireTokenScope(req: Request, res: Response, next: NextFunction): void {
  const { scopes } = principalOf(req);
  if (!scopes) {
    next();
    return;
  }
  if (!scopeAllowsMethod(scopes, req.method)) {
    res.status(403).json({ error: 'this API token is read-only; it needs the write scope' });
    return;
  }
  next();
}

/** The caller of an authenticated request. Throws if used before `requireAuth`. */
export function principalOf(req: Request): Principal {
  const principal = (req as AuthedRequest).principal;
  if (!principal) throw new Error('principalOf called on an unauthenticated request');
  return principal;
}

/** Guards routes that administer the panel itself (nodes, accounts). */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  const { platformRole, scopes } = principalOf(req);
  if (platformRole !== 'owner' && platformRole !== 'admin') {
    res.status(403).json({ error: 'platform administrator role required' });
    return;
  }
  // An administrator's token administers the panel only if it was asked to (#228).
  // A CI token that deploys should not also be able to create accounts, and the
  // account holding it usually has no idea it could.
  if (scopes && !scopeAllowsAdmin(scopes)) {
    res.status(403).json({ error: 'this API token does not have the admin scope' });
    return;
  }
  next();
}

export interface AuthRouterDeps {
  users: UserService;
  /** Where sessions live, so a token can be revoked (#227). */
  repo: Repository;
  provider?: AuthProvider;
  /** Overrides the edition-derived signup policy; for tests. */
  allowSelfRegistration?: boolean;
  /** Injected so tests drive the clock; one is created per router otherwise (#225). */
  loginLimiter?: LoginLimiter;
}

/** Public auth routes (login, registration). Mount before `requireAuth`. */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { users, repo } = deps;
  const provider = deps.provider ?? createLocalAuthProvider(users);
  const selfRegistration = deps.allowSelfRegistration ?? canSelfRegister();
  const limiter = deps.loginLimiter ?? createLoginLimiter();
  const router = Router();

  router.post('/auth/login', async (req: Request, res: Response) => {
    const { username, email, password } = req.body ?? {};
    const identifier = typeof email === 'string' && email ? email : username;
    if (typeof identifier !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // Measured per address and per account (#225): the first stops one machine
    // walking a password list, the second stops a botnet spreading the same list
    // across many addresses. Neither alone is enough.
    const keys = loginKeys(req.ip, identifier);
    const verdict = limiter.check(keys);
    if (!verdict.allowed) {
      // Deliberately the same body as a wrong password. A distinct "locked"
      // response would confirm the account exists and is worth attacking, which
      // is exactly what the identical 401 below is there to prevent — and it
      // would report on an account the caller may have no relationship with.
      res.setHeader('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const principal = await provider.login(identifier, password);
    // One message for both "no such account" and "wrong password", so the
    // response can't be used to enumerate which emails exist.
    if (!principal) {
      limiter.fail(keys);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    // A correct password means this was never an attack, so nothing is held
    // against the address or the account.
    limiter.succeed(keys);

    // Every login is a session, so it can be ended later without waiting for the
    // token to expire (#227).
    const session = await repo.createSession({
      userId: principal.id,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip ?? null,
    });
    return res.json({ token: signToken({ ...principal, sessionId: session.id }) });
  });

  router.post('/auth/register', async (req: Request, res: Response) => {
    if (!selfRegistration) {
      return res.status(403).json({ error: 'self-registration is disabled; ask an administrator for an account' });
    }
    // The other unauthenticated write. Limited per address only — there is no
    // account to key on yet, and keying on the submitted email would let anyone
    // lock a stranger out of registering theirs.
    const ipKeys = loginKeys(req.ip, undefined);
    if (!limiter.check(ipKeys).allowed) {
      return res.status(429).json({ error: 'too many attempts; try again later' });
    }
    const { email, password, displayName } = req.body ?? {};
    const result = await users.register({ email: String(email ?? ''), password: String(password ?? ''), displayName });
    if (!result.ok) {
      limiter.fail(ipKeys);
      return res.status(result.status).json({ error: result.error });
    }
    const session = await repo.createSession({
      userId: result.user.id,
      userAgent: req.headers['user-agent'] ?? null,
      ipAddress: req.ip ?? null,
    });
    return res.status(201).json({
      token: signToken({ id: result.user.id, platformRole: 'user', sessionId: session.id }),
      user: toPublicUser(result.user),
    });
  });

  return router;
}

/** Authenticated routes about the caller themselves. Mount after `requireAuth`. */
export function createAccountRouter(deps: { users: UserService; repo: Repository }): Router {
  const { users, repo } = deps;
  const router = Router();

  router.get('/me', async (req: Request, res: Response) => {
    const user = await repo.getUser(principalOf(req).id);
    if (!user) return res.status(404).json({ error: 'user not found' });
    return res.json(toPublicUser(user));
  });

  router.post('/me/password', async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const principal = principalOf(req);
    const result = await users.changePassword(principal.id, String(currentPassword ?? ''), String(newPassword ?? ''));
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // Changing a password is how you respond to a suspicion that someone else has
    // it, so every other session ends. The one doing the changing stays signed in
    // — being logged out of the page you just used is a punishment for doing the
    // right thing.
    await repo.deleteSessionsForUser(principal.id, principal.sessionId);
    return res.status(204).end();
  });

  // ── Sessions (#227) ────────────────────────────────────────────────────────

  /** Where you are signed in. Never another account's — this is about yourself. */
  router.get('/me/sessions', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    const sessions = await repo.listSessions(principal.id);
    res.json(sessions.map((s) => ({ ...s, current: s.id === principal.sessionId })));
  });

  /** End this session. The token stops working immediately, not at expiry. */
  router.post('/auth/logout', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    if (principal.sessionId) await repo.deleteSession(principal.sessionId);
    res.status(204).end();
  });

  /** End one other session — the "that wasn't me" button. */
  router.delete('/me/sessions/:id', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    const session = await repo.getSession(req.params.id);
    // A session that isn't yours answers 404 rather than 403, so session ids
    // cannot be probed for existence — the same rule as servers (#175).
    if (!session || session.userId !== principal.id) return res.status(404).json({ error: 'session not found' });
    await repo.deleteSession(session.id);
    return res.status(204).end();
  });

  /** End every other session, keeping this one. */
  router.delete('/me/sessions', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    await repo.deleteSessionsForUser(principal.id, principal.sessionId);
    res.status(204).end();
  });

  // ── API tokens (#228) ──────────────────────────────────────────────────────

  /**
   * Your tokens. The digest never leaves the server — a list that returned it
   * would make every one of these rows a credential again.
   */
  router.get('/me/tokens', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    res.json((await repo.listApiTokens(principal.id)).map(toPublicToken));
  });

  /**
   * Mint one. The secret is in this response and nowhere else, ever again.
   *
   * Only a password login may do this. A token that can mint tokens is a token
   * that cannot really be revoked: withdraw it and its offspring keep working,
   * which is the opposite of the property this feature exists to provide.
   */
  router.post('/me/tokens', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    if (principal.tokenId) {
      return res.status(403).json({ error: 'an API token cannot create API tokens; sign in to do this' });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'a name is required — it is how you recognise this token later' });

    const requested: unknown = req.body?.scopes ?? [];
    if (!Array.isArray(requested) || !requested.every(isApiScope)) {
      return res.status(400).json({ error: 'scopes must be an array of "write" and/or "admin"' });
    }

    const expiresAt = req.body?.expiresAt;
    if (expiresAt !== undefined && expiresAt !== null) {
      if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
        return res.status(400).json({ error: 'expiresAt must be an ISO timestamp or null' });
      }
      if (isExpired(expiresAt)) return res.status(400).json({ error: 'expiresAt is already in the past' });
    }

    const { secret, hash } = generateApiToken();
    const record = await repo.createApiToken({
      userId: principal.id,
      name,
      tokenHash: hash,
      scopes: formatScopes(requested as ApiScope[]),
      expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    });
    return res.status(201).json({ ...toPublicToken(record), secret });
  });

  /** Revoke one. Effective on the very next request, like ending a session. */
  router.delete('/me/tokens/:id', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    const token = await repo.getApiToken(req.params.id);
    // Somebody else's token answers 404 rather than 403, so ids cannot be probed
    // — the same rule as sessions and servers.
    if (!token || token.userId !== principal.id) return res.status(404).json({ error: 'token not found' });
    await repo.deleteApiToken(token.id);
    return res.status(204).end();
  });

  return router;
}

/** A token as it may be shown: everything except the thing that authenticates. */
function toPublicToken(token: ApiTokenRecord) {
  return {
    id: token.id,
    name: token.name,
    scopes: parseScopes(token.scopes),
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
  };
}

/**
 * Account administration. This is how accounts come into being in the community
 * edition, where self-registration is closed — and how anyone is looked up by
 * email when sharing a server (#176) or adding a team member (#177).
 */
export function createUserAdminRouter(deps: { users: UserService; repo: Repository }): Router {
  const { users, repo } = deps;
  const router = Router();

  router.get('/users', requirePlatformAdmin, async (_req: Request, res: Response) => {
    res.json((await repo.listUsers()).map(toPublicUser));
  });

  router.post('/users', requirePlatformAdmin, async (req: Request, res: Response) => {
    const { email, password, displayName, platformRole } = req.body ?? {};
    if (platformRole !== undefined && !isPlatformRole(platformRole)) {
      return res.status(400).json({ error: 'platformRole must be owner, admin or user' });
    }
    const result = await users.register({ email: String(email ?? ''), password: String(password ?? ''), displayName, platformRole });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json(toPublicUser(result.user));
  });

  /**
   * Reset somebody's password (#226).
   *
   * The community edition's answer to a forgotten password: there is no mail
   * server to assume, and accounts are created by an administrator anyway, so the
   * administrator sets a new one and tells the person.
   *
   * Two rules make this safe to hand to an `admin` rather than only an `owner`:
   *
   * - You cannot reset an account that outranks you, or the installation's owner
   *   could be locked out by any administrator they appointed. An admin resetting
   *   another admin is allowed; both already hold the same power.
   * - Every session belonging to that account ends (#227). A reset is what you do
   *   when you think somebody else is in the account — leaving their existing
   *   token working would defeat the entire exercise.
   */
  router.post('/users/:id/password', requirePlatformAdmin, async (req: Request, res: Response) => {
    const actor = principalOf(req);
    const target = await repo.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'account not found' });

    const rank: Record<string, number> = { user: 0, admin: 1, owner: 2 };
    if ((rank[target.platformRole] ?? 0) > (rank[actor.platformRole] ?? 0)) {
      return res.status(403).json({ error: 'you cannot reset the password of an account that outranks you' });
    }

    const result = await users.resetPassword(target.id, String((req.body ?? {}).newPassword ?? ''));
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    await repo.deleteSessionsForUser(target.id);
    return res.status(204).end();
  });

  return router;
}
