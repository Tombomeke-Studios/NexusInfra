import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rateLimit.js';

describe('RateLimiter (token bucket)', () => {
  it('allows up to the burst immediately, then blocks', () => {
    const rl = new RateLimiter({ ratePerSec: 1, burst: 3 });
    expect(rl.allow('ip', 0)).toBe(true);
    expect(rl.allow('ip', 0)).toBe(true);
    expect(rl.allow('ip', 0)).toBe(true);
    expect(rl.allow('ip', 0)).toBe(false); // burst exhausted at the same instant
  });

  it('refills over time at the configured rate', () => {
    const rl = new RateLimiter({ ratePerSec: 2, burst: 2 });
    expect(rl.allow('ip', 0)).toBe(true);
    expect(rl.allow('ip', 0)).toBe(true);
    expect(rl.allow('ip', 0)).toBe(false);
    // 0.5s later → 1 token refilled (2/sec × 0.5)
    expect(rl.allow('ip', 500)).toBe(true);
    expect(rl.allow('ip', 500)).toBe(false);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ ratePerSec: 1, burst: 1 });
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('b', 0)).toBe(true); // different key has its own bucket
    expect(rl.allow('a', 0)).toBe(false);
  });

  it('never exceeds the burst cap on long idle', () => {
    const rl = new RateLimiter({ ratePerSec: 1, burst: 2 });
    expect(rl.allow('ip', 0)).toBe(true); // 1 left
    // idle 1 hour → refill capped at burst (2), so only 2 allowed back-to-back
    expect(rl.allow('ip', 3_600_000)).toBe(true);
    expect(rl.allow('ip', 3_600_000)).toBe(true);
    expect(rl.allow('ip', 3_600_000)).toBe(false);
  });
});
