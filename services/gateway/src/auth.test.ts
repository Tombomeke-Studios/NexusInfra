import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { bearerToken, verifyToken } from './auth.js';

const SECRET = 'test-secret';

describe('bearerToken', () => {
  it('extracts a Bearer token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
  });
  it('returns null without a Bearer prefix', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic xyz')).toBeNull();
  });
});

describe('verifyToken', () => {
  it('returns the subject for a valid token', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);
    expect(verifyToken(token, SECRET)).toEqual({ userId: 'user-1' });
  });
  it('throws on a bad signature', () => {
    const token = jwt.sign({ sub: 'user-1' }, SECRET);
    expect(() => verifyToken(token, 'other-secret')).toThrow();
  });
  it('throws when the subject is missing', () => {
    const token = jwt.sign({ foo: 'bar' }, SECRET);
    expect(() => verifyToken(token, SECRET)).toThrow();
  });
});
