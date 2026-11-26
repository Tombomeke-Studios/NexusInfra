import { createHash, timingSafeEqual } from 'crypto';

// Shared secret for service-to-service calls on the private network (#169).
//
// The Node Agent's HTTP/WS surface drives Docker directly (exec, file writes, an
// interactive shell), so it must not be callable by anything but the Orchestrator.
// It was previously unauthenticated, which made the Orchestrator's JWT boundary
// bypassable by anyone who could reach the agent's port.
//
// Default follows the existing JWT_SECRET convention so local dev works without
// setup — it MUST be overridden in any real deployment (see docs/security.md).

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

export const DEV_INTERNAL_TOKEN = 'dev-internal-token';

/** The shared internal token for this process. */
export function getInternalToken(): string {
  return process.env.INTERNAL_API_TOKEN || DEV_INTERNAL_TOKEN;
}

/**
 * The token a rotation is moving away from, if one is configured. Receivers accept it
 * beside the current token; senders never send it. See docs/security.md for the order
 * of a rotation.
 */
export function getPreviousInternalToken(): string | undefined {
  const previous = process.env.INTERNAL_API_TOKEN_PREVIOUS;
  return previous && previous !== getInternalToken() ? previous : undefined;
}

/** Every token a receiver should accept right now: the current one, and the previous one mid-rotation. */
export function acceptedInternalTokens(): string[] {
  const previous = getPreviousInternalToken();
  return previous ? [getInternalToken(), previous] : [getInternalToken()];
}

/** True when running on the insecure built-in default (worth warning about). */
export function isDefaultInternalToken(token: string = getInternalToken()): boolean {
  return token === DEV_INTERNAL_TOKEN;
}

/**
 * Constant-time token comparison. Hashing first gives both sides a fixed, equal
 * length, so `timingSafeEqual` can't throw on length mismatch and the comparison
 * leaks neither the token's length nor its contents through timing.
 */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * `tokensMatch` against several acceptable tokens (rotation, see
 * `acceptedInternalTokens`). Every candidate is compared, with no early exit, so how
 * long the check takes does not say which of them matched.
 */
export function tokenAccepted(provided: string | undefined, accepted: string | string[]): boolean {
  const list = Array.isArray(accepted) ? accepted : [accepted];
  let ok = false;
  for (const token of list) ok = tokensMatch(provided, token) || ok;
  return ok;
}
