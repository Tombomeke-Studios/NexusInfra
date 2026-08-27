import { describe, it, expect } from 'vitest';
import {
  API_TOKEN_PREFIX,
  formatScopes,
  generateApiToken,
  hashApiToken,
  isApiScope,
  isApiTokenSecret,
  isExpired,
  isSafeMethod,
  parseScopes,
  scopeAllowsAdmin,
  scopeAllowsMethod,
  tokenHashesMatch,
} from './apiTokens.js';

describe('minting a token', () => {
  it('returns a prefixed secret and a digest that is not the secret', () => {
    const { secret, hash } = generateApiToken();
    expect(secret.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(hash).not.toContain(secret);
    expect(hash).toHaveLength(64); // sha-256, hex
    expect(hashApiToken(secret)).toBe(hash);
  });

  it('never mints the same secret twice', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateApiToken().secret));
    expect(secrets.size).toBe(50);
  });

  it('recognises its own secrets and nothing else', () => {
    expect(isApiTokenSecret(generateApiToken().secret)).toBe(true);
    // A JWT must not be mistaken for one, or the wrong lookup runs.
    expect(isApiTokenSecret('eyJhbGciOiJIUzI1NiJ9.e30.abc')).toBe(false);
    expect(isApiTokenSecret(API_TOKEN_PREFIX)).toBe(false);
    expect(isApiTokenSecret('')).toBe(false);
  });

  it('compares digests without leaking where they differ', () => {
    const { hash } = generateApiToken();
    expect(tokenHashesMatch(hash, hash)).toBe(true);
    expect(tokenHashesMatch(hash, hashApiToken('nxi_other'))).toBe(false);
    expect(tokenHashesMatch(hash, 'short')).toBe(false);
  });
});

describe('scopes', () => {
  it('lets any token read, and only a write token change anything', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(scopeAllowsMethod([], method)).toBe(true);
      expect(isSafeMethod(method)).toBe(true);
    }
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(scopeAllowsMethod([], method)).toBe(false);
      expect(scopeAllowsMethod(['write'], method)).toBe(true);
      expect(isSafeMethod(method)).toBe(false);
    }
  });

  it('treats an unknown method as changing something', () => {
    // Failing closed: a method nobody listed is not assumed harmless.
    expect(scopeAllowsMethod([], 'FROBNICATE')).toBe(false);
  });

  it('keeps panel administration behind its own scope', () => {
    // A CI token that deploys should not also be able to create accounts, even
    // when the account behind it is an administrator.
    expect(scopeAllowsAdmin(['write'])).toBe(false);
    expect(scopeAllowsAdmin(['admin'])).toBe(true);
  });

  it('round-trips through the stored form, dropping anything unrecognised', () => {
    expect(parseScopes('write admin')).toEqual(['write', 'admin']);
    expect(parseScopes('write everything')).toEqual(['write']);
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(formatScopes(['write', 'write', 'admin'])).toBe('write admin');
    expect(isApiScope('write')).toBe(true);
    expect(isApiScope('root')).toBe(false);
  });
});

describe('expiry', () => {
  const now = new Date('2026-08-27T12:00:00.000Z');

  it('treats a token with no expiry as living forever', () => {
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });

  it('expires on the boundary rather than a moment after it', () => {
    expect(isExpired('2026-08-27T12:00:00.000Z', now)).toBe(true);
    expect(isExpired('2026-08-27T11:59:59.000Z', now)).toBe(true);
    expect(isExpired('2026-08-27T12:00:01.000Z', now)).toBe(false);
  });
});
