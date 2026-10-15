// Rate limiting for credential checks (#225).
//
// The API Gateway has a per-IP limiter, and the dashboard's nginx proxies /api
// straight to the Orchestrator, going around it. So `POST /auth/login` could be
// hammered without limit, against bcrypt hashes whose only protection is the work
// factor — which slows an attacker down by a constant, not by enough.
//
// Two keys are checked per attempt, and both matter:
//
// - **per IP**, which stops one machine walking a password list;
// - **per account**, which stops a botnet spreading the same list across many
//   addresses. Neither alone is sufficient, so a request must pass both.
//
// Only *failed* attempts count and a success clears the count, so someone using
// the panel normally never meets the limit however often they sign in.
//
// Pure: the clock is injected, so the tests are exact rather than timing-based.

export interface LoginLimiterOptions {
  /** Failures allowed inside the window before the key is locked out. */
  maxAttempts?: number;
  /** How long failures are remembered, in milliseconds. */
  windowMs?: number;
  /** How long a locked-out key stays locked, in milliseconds. */
  lockoutMs?: number;
  now?: () => number;
}

export interface LimitVerdict {
  allowed: boolean;
  /** How long until this key may try again, when it is locked out. */
  retryAfterMs: number;
}

interface Entry {
  failures: number;
  /** When the current window started. */
  since: number;
  /** When a lockout ends; 0 when not locked out. */
  lockedUntil: number;
}

export interface LoginLimiter {
  /** Whether these keys may attempt a login right now. */
  check(keys: string[]): LimitVerdict;
  /** Record a failed attempt against every key. */
  fail(keys: string[]): void;
  /** Clear every key — a correct password means this was never an attack. */
  succeed(keys: string[]): void;
  /** Number of tracked keys, for the sweep test. */
  size(): number;
}

const DEFAULTS = {
  maxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS) || 10,
  windowMs: Number(process.env.LOGIN_WINDOW_MS) || 15 * 60 * 1000,
  lockoutMs: Number(process.env.LOGIN_LOCKOUT_MS) || 15 * 60 * 1000,
};

export function createLoginLimiter(options: LoginLimiterOptions = {}): LoginLimiter {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const lockoutMs = options.lockoutMs ?? DEFAULTS.lockoutMs;
  const now = options.now ?? Date.now;

  const entries = new Map<string, Entry>();

  /**
   * Drop keys that have nothing left to remember.
   *
   * Without this the map is an unbounded memory leak keyed by attacker-supplied
   * strings — every address and every guessed email would be kept forever, which
   * turns a rate limiter into a way to exhaust the process.
   */
  function sweep(at: number): void {
    for (const [key, entry] of entries) {
      const expired = at - entry.since >= windowMs && entry.lockedUntil <= at;
      if (expired) entries.delete(key);
    }
  }

  function entryFor(key: string, at: number): Entry {
    const existing = entries.get(key);
    if (!existing) return { failures: 0, since: at, lockedUntil: 0 };
    // A window that has run out starts again rather than accumulating forever.
    if (at - existing.since >= windowMs && existing.lockedUntil <= at) {
      return { failures: 0, since: at, lockedUntil: 0 };
    }
    return existing;
  }

  return {
    check(keys) {
      const at = now();
      let retryAfterMs = 0;
      for (const key of keys) {
        const entry = entryFor(key, at);
        if (entry.lockedUntil > at) retryAfterMs = Math.max(retryAfterMs, entry.lockedUntil - at);
      }
      return { allowed: retryAfterMs === 0, retryAfterMs };
    },

    fail(keys) {
      const at = now();
      sweep(at);
      for (const key of keys) {
        const entry = entryFor(key, at);
        entry.failures += 1;
        if (entry.failures >= maxAttempts) entry.lockedUntil = at + lockoutMs;
        entries.set(key, entry);
      }
    },

    succeed(keys) {
      for (const key of keys) entries.delete(key);
    },

    size() {
      return entries.size;
    },
  };
}

/** The keys one attempt is measured against: where it came from, and who it targets. */
export function loginKeys(ip: string | undefined, identifier: string | undefined): string[] {
  const keys: string[] = [];
  if (ip) keys.push(`ip:${ip}`);
  // Lower-cased so Ada@example.com and ada@example.com share a budget rather than
  // doubling it — case is not a new account.
  if (identifier?.trim()) keys.push(`id:${identifier.trim().toLowerCase()}`);
  return keys;
}
