import { describe, it, expect } from 'vitest';
import { createLoginLimiter, loginKeys } from './loginLimiter.js';

// The gateway's limiter is bypassed by the dashboard's nginx, so credential
// checks were unlimited against bcrypt hashes (#225).

const OPTS = { maxAttempts: 3, windowMs: 1000, lockoutMs: 5000 };

describe('createLoginLimiter', () => {
  it('allows attempts until the limit is reached', () => {
    const t = 0;
    const limiter = createLoginLimiter({ ...OPTS, now: () => t });

    for (let i = 0; i < 2; i++) {
      expect(limiter.check(['ip:1']).allowed).toBe(true);
      limiter.fail(['ip:1']);
    }
    expect(limiter.check(['ip:1']).allowed).toBe(true);

    limiter.fail(['ip:1']); // the third failure
    expect(limiter.check(['ip:1']).allowed).toBe(false);
  });

  it('says how long the caller must wait', () => {
    let t = 0;
    const limiter = createLoginLimiter({ ...OPTS, now: () => t });
    for (let i = 0; i < 3; i++) limiter.fail(['ip:1']);

    expect(limiter.check(['ip:1']).retryAfterMs).toBe(5000);
    t = 2000;
    expect(limiter.check(['ip:1']).retryAfterMs).toBe(3000);
  });

  it('lets the key through again once the lockout passes', () => {
    let t = 0;
    const limiter = createLoginLimiter({ ...OPTS, now: () => t });
    for (let i = 0; i < 3; i++) limiter.fail(['ip:1']);

    t = 5001;
    expect(limiter.check(['ip:1']).allowed).toBe(true);
  });

  it('forgets failures that fall outside the window', () => {
    let t = 0;
    const limiter = createLoginLimiter({ ...OPTS, now: () => t });
    limiter.fail(['ip:1']);
    limiter.fail(['ip:1']);

    // Two failures, then a long gap: this is a person mistyping, not an attack.
    t = 1001;
    limiter.fail(['ip:1']);
    expect(limiter.check(['ip:1']).allowed).toBe(true);
  });

  it('clears the count on a correct password', () => {
    const t = 0;
    const limiter = createLoginLimiter({ ...OPTS, now: () => t });
    limiter.fail(['ip:1']);
    limiter.fail(['ip:1']);
    limiter.succeed(['ip:1']);

    // Someone who signs in normally never approaches the limit, however often.
    limiter.fail(['ip:1']);
    limiter.fail(['ip:1']);
    expect(limiter.check(['ip:1']).allowed).toBe(true);
  });

  // Two keys, because either alone leaves an obvious hole.
  it('locks one address without touching another', () => {
    const limiter = createLoginLimiter({ ...OPTS, now: () => 0 });
    for (let i = 0; i < 3; i++) limiter.fail(['ip:1', 'id:ada@example.com']);

    expect(limiter.check(['ip:2', 'id:bob@example.com']).allowed).toBe(true);
  });

  it('locks an account that is attacked from many addresses', () => {
    // Per-IP limiting alone is defeated by a botnet spreading one password list.
    const limiter = createLoginLimiter({ ...OPTS, now: () => 0 });
    limiter.fail(['ip:1', 'id:ada@example.com']);
    limiter.fail(['ip:2', 'id:ada@example.com']);
    limiter.fail(['ip:3', 'id:ada@example.com']);

    expect(limiter.check(['ip:4', 'id:ada@example.com']).allowed).toBe(false);
    // Every address is still fresh; only the targeted account is locked.
    expect(limiter.check(['ip:4', 'id:bob@example.com']).allowed).toBe(true);
  });

  it('refuses when any one of the keys is locked', () => {
    const limiter = createLoginLimiter({ ...OPTS, now: () => 0 });
    for (let i = 0; i < 3; i++) limiter.fail(['ip:1']);
    expect(limiter.check(['ip:1', 'id:fresh@example.com']).allowed).toBe(false);
  });

  it('forgets keys it no longer needs, so it cannot be filled up', () => {
    // The map is keyed by attacker-supplied strings; without a sweep it is an
    // unbounded leak and the limiter becomes a way to exhaust the process.
    let t = 0;
    const limiter = createLoginLimiter({ ...OPTS, now: () => t });
    for (let i = 0; i < 50; i++) limiter.fail([`id:guess-${i}@example.com`]);
    expect(limiter.size()).toBe(50);

    t = 100000;
    limiter.fail(['id:one-more@example.com']);
    expect(limiter.size()).toBe(1);
  });
});

describe('loginKeys', () => {
  it('measures an attempt by where it came from and who it targets', () => {
    expect(loginKeys('10.0.0.1', 'ada@example.com')).toEqual(['ip:10.0.0.1', 'id:ada@example.com']);
  });

  it('treats an address as one identity whatever its case', () => {
    // Otherwise Ada@ and ada@ get separate budgets, doubling the allowance.
    expect(loginKeys('10.0.0.1', '  Ada@Example.com ')).toEqual(['ip:10.0.0.1', 'id:ada@example.com']);
  });

  it('copes with either part being missing', () => {
    expect(loginKeys(undefined, 'ada@example.com')).toEqual(['id:ada@example.com']);
    expect(loginKeys('10.0.0.1', '')).toEqual(['ip:10.0.0.1']);
    expect(loginKeys(undefined, undefined)).toEqual([]);
  });
});
