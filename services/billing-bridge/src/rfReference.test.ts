import { describe, it, expect } from 'vitest';
import { isRfReference, newTopUpReference, rfReference } from './rfReference.js';

describe('rfReference (#436)', () => {
  it('matches ISO 11649’s own example', () => {
    expect(rfReference('539007547034')).toBe('RF18539007547034');
  });

  it('pads a single-digit check', () => {
    // Any body whose check is below 10 must still give two digits.
    const ref = rfReference('A');
    expect(ref).toMatch(/^RF\d{2}A$/);
    expect(isRfReference(ref)).toBe(true);
  });

  it('refuses a body an RF reference cannot hold', () => {
    expect(() => rfReference('')).toThrow();
    expect(() => rfReference('A'.repeat(22))).toThrow();
    expect(() => rfReference('top-up')).toThrow();
  });
});

describe('isRfReference', () => {
  it('accepts a valid reference and refuses a wrong check or shape', () => {
    expect(isRfReference('RF18539007547034')).toBe(true);
    expect(isRfReference('RF19539007547034')).toBe(false);
    expect(isRfReference('topup-u1-0f8c…')).toBe(false);
  });
});

describe('newTopUpReference', () => {
  it('is a valid RF reference of the longest allowed length', () => {
    const ref = newTopUpReference();
    expect(ref).toMatch(/^RF\d{2}[0-9A-Z]{21}$/);
    expect(isRfReference(ref)).toBe(true);
  });

  it('draws every character from the random source', () => {
    expect(newTopUpReference(() => 10)).toBe(rfReference('A'.repeat(21)));
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newTopUpReference()));
    expect(seen.size).toBe(200);
  });
});
