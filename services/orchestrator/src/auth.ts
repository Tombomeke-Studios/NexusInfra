import { Router, type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Stub authentication for the dashboard MVP. This is intentionally minimal —
// a single seeded dev user and a locally-signed JWT — so the panel has a user
// identity without depending on FinVault. The real deal (FinVault-issued JWTs
// validated at the API Gateway) is a later phase (#20); nothing here should be
// treated as production-grade auth.

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const TOKEN_TTL = '12h';

// Seeded credentials (override via env for local convenience).
const DEV_USERNAME = process.env.DEV_USERNAME || 'admin';
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'admin';

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): string {
  const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string };
  if (!decoded.sub) throw new Error('token missing subject');
  return decoded.sub;
}

/** Express middleware: requires a valid Bearer token and sets `req.userId`. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    (req as Request & { userId?: string }).userId = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

/** Router exposing the public login endpoint. Mount before `requireAuth`. */
export function createAuthRouter(): Router {
  const router = Router();

  router.post('/auth/login', (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};
    if (username === DEV_USERNAME && password === DEV_PASSWORD) {
      return res.json({ token: signToken(String(username)) });
    }
    return res.status(401).json({ error: 'invalid credentials' });
  });

  return router;
}
