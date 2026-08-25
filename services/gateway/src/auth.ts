import jwt from 'jsonwebtoken';

// JWT validation for the gateway. It verifies the same tokens the Orchestrator's
// stub login issues today (shared JWT_SECRET); when the FinVault-issued JWT lands
// (#17) only the verification key/issuer changes here — the routing/proxy stays
// the same.

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface VerifiedToken {
  userId: string;
}

/** Verify a Bearer token, returning its subject; throws on invalid/expired. */
export function verifyToken(token: string, secret: string = JWT_SECRET): VerifiedToken {
  const decoded = jwt.verify(token, secret) as { sub?: string };
  if (!decoded.sub) throw new Error('token missing subject');
  return { userId: decoded.sub };
}

/** Extract a Bearer token from an Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}
