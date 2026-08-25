import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { canSelfRegister, isPlatformRole, toPublicUser, type PlatformRole, type UserService } from './users.js';
import type { Repository } from './types.js';

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
  return jwt.sign({ sub: principal.id, role: principal.platformRole }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Decode and validate a token into its Principal; throws when it isn't valid. */
export function verifyToken(token: string): Principal {
  const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string; role?: string };
  if (!decoded.sub) throw new Error('token missing subject');
  return { id: decoded.sub, platformRole: isPlatformRole(decoded.role) ? decoded.role : 'user' };
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

/** The caller of an authenticated request. Throws if used before `requireAuth`. */
export function principalOf(req: Request): Principal {
  const principal = (req as AuthedRequest).principal;
  if (!principal) throw new Error('principalOf called on an unauthenticated request');
  return principal;
}

/** Guards routes that administer the panel itself (nodes, accounts). */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  const { platformRole } = principalOf(req);
  if (platformRole !== 'owner' && platformRole !== 'admin') {
    res.status(403).json({ error: 'platform administrator role required' });
    return;
  }
  next();
}

export interface AuthRouterDeps {
  users: UserService;
  provider?: AuthProvider;
  /** Overrides the edition-derived signup policy; for tests. */
  allowSelfRegistration?: boolean;
}

/** Public auth routes (login, registration). Mount before `requireAuth`. */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { users } = deps;
  const provider = deps.provider ?? createLocalAuthProvider(users);
  const selfRegistration = deps.allowSelfRegistration ?? canSelfRegister();
  const router = Router();

  router.post('/auth/login', async (req: Request, res: Response) => {
    const { username, email, password } = req.body ?? {};
    const identifier = typeof email === 'string' && email ? email : username;
    if (typeof identifier !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const principal = await provider.login(identifier, password);
    // One message for both "no such account" and "wrong password", so the
    // response can't be used to enumerate which emails exist.
    if (!principal) return res.status(401).json({ error: 'invalid credentials' });
    return res.json({ token: signToken(principal) });
  });

  router.post('/auth/register', async (req: Request, res: Response) => {
    if (!selfRegistration) {
      return res.status(403).json({ error: 'self-registration is disabled; ask an administrator for an account' });
    }
    const { email, password, displayName } = req.body ?? {};
    const result = await users.register({ email: String(email ?? ''), password: String(password ?? ''), displayName });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({ token: signToken({ id: result.user.id, platformRole: 'user' }), user: toPublicUser(result.user) });
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
    const result = await users.changePassword(principalOf(req).id, String(currentPassword ?? ''), String(newPassword ?? ''));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(204).end();
  });

  return router;
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

  return router;
}
