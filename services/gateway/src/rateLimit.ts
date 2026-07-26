// Pure token-bucket rate limiter for the gateway (#20). Each key (per-IP or
// per-user) gets a bucket that refills continuously at `ratePerSec` up to
// `burst`. `allow` is a pure function of the stored state + the current time, so
// it's deterministic and testable with an injected clock.

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiterOptions {
  /** Sustained requests allowed per second. */
  ratePerSec: number;
  /** Maximum burst (bucket capacity). */
  burst: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly opts: RateLimiterOptions) {}

  /** Consume one token for `key` at time `nowMs`; returns whether the request is allowed. */
  allow(key: string, nowMs: number): boolean {
    const { ratePerSec, burst } = this.opts;
    const bucket = this.buckets.get(key) ?? { tokens: burst, lastRefillMs: nowMs };
    const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    const refilled = Math.min(burst, bucket.tokens + elapsedSec * ratePerSec);
    const allowed = refilled >= 1;
    const tokens = allowed ? refilled - 1 : refilled;
    this.buckets.set(key, { tokens, lastRefillMs: nowMs });
    return allowed;
  }

  /** Drop a key's bucket (mainly for tests/cleanup). */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}
