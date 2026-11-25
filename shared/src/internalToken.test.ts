import { describe, it, expect, afterEach } from 'vitest';
import { DEV_INTERNAL_TOKEN, acceptedInternalTokens, getInternalToken, getPreviousInternalToken, isDefaultInternalToken, tokenAccepted, tokensMatch } from './internalToken.js';

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

describe('rotation (INTERNAL_API_TOKEN_PREVIOUS)', () => {
  const saved = { current: process.env.INTERNAL_API_TOKEN, previous: process.env.INTERNAL_API_TOKEN_PREVIOUS };
  afterEach(() => {
    for (const [key, value] of [['INTERNAL_API_TOKEN', saved.current], ['INTERNAL_API_TOKEN_PREVIOUS', saved.previous]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts only the current token when no rotation is under way', () => {
    process.env.INTERNAL_API_TOKEN = 'new';
    delete process.env.INTERNAL_API_TOKEN_PREVIOUS;
    expect(getPreviousInternalToken()).toBeUndefined();
    expect(acceptedInternalTokens()).toEqual(['new']);
  });

  it('accepts the previous token too while one is configured', () => {
    process.env.INTERNAL_API_TOKEN = 'new';
    process.env.INTERNAL_API_TOKEN_PREVIOUS = 'old';
    expect(acceptedInternalTokens()).toEqual(['new', 'old']);
    expect(tokenAccepted('old', acceptedInternalTokens())).toBe(true);
    expect(tokenAccepted('new', acceptedInternalTokens())).toBe(true);
    expect(tokenAccepted('older', acceptedInternalTokens())).toBe(false);
  });

  it('never sends the previous token', () => {
    process.env.INTERNAL_API_TOKEN = 'new';
    process.env.INTERNAL_API_TOKEN_PREVIOUS = 'old';
    expect(getInternalToken()).toBe('new');
  });

  it('ignores an empty previous token, so an unset-by-template variable opens nothing', () => {
    process.env.INTERNAL_API_TOKEN = 'new';
    process.env.INTERNAL_API_TOKEN_PREVIOUS = '';
    expect(acceptedInternalTokens()).toEqual(['new']);
    expect(tokenAccepted('', acceptedInternalTokens())).toBe(false);
  });

  it('ignores a previous token equal to the current one', () => {
    process.env.INTERNAL_API_TOKEN = 'same';
    process.env.INTERNAL_API_TOKEN_PREVIOUS = 'same';
    expect(acceptedInternalTokens()).toEqual(['same']);
  });
});
