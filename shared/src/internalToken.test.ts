import { describe, it, expect, afterEach } from 'vitest';
import { DEV_INTERNAL_TOKEN, getInternalToken, isDefaultInternalToken, tokensMatch } from './internalToken.js';

describe('getInternalToken', () => {
  const original = process.env.INTERNAL_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = original;
  });

  it('falls back to the dev default when unset', () => {
    delete process.env.INTERNAL_API_TOKEN;
    expect(getInternalToken()).toBe(DEV_INTERNAL_TOKEN);
    expect(isDefaultInternalToken()).toBe(true);
  });

  it('reads INTERNAL_API_TOKEN when set', () => {
    process.env.INTERNAL_API_TOKEN = 'a-real-secret';
    expect(getInternalToken()).toBe('a-real-secret');
    expect(isDefaultInternalToken()).toBe(false);
  });
});

describe('tokensMatch', () => {
  it('accepts an exact match', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true);
  });

  it('rejects a different token', () => {
    expect(tokensMatch('nope', 'secret')).toBe(false);
  });

  it('rejects a missing or empty token', () => {
    expect(tokensMatch(undefined, 'secret')).toBe(false);
    expect(tokensMatch('', 'secret')).toBe(false);
  });

  it('rejects a prefix without throwing on length mismatch', () => {
    // Hashing both sides keeps timingSafeEqual's equal-length requirement satisfied.
    expect(tokensMatch('sec', 'secret')).toBe(false);
    expect(tokensMatch('secret-and-then-some', 'secret')).toBe(false);
  });

  it('is case sensitive', () => {
    expect(tokensMatch('SECRET', 'secret')).toBe(false);
  });
});
