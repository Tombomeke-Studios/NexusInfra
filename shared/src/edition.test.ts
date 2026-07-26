import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EDITION, getEdition, isHosted, resolveEdition } from './edition.js';

describe('resolveEdition', () => {
  it('defaults to community for undefined/null/empty', () => {
    expect(resolveEdition(undefined)).toBe('community');
    expect(resolveEdition(null)).toBe('community');
    expect(resolveEdition('')).toBe('community');
    expect(DEFAULT_EDITION).toBe('community');
  });

  it('accepts hosted (case-insensitive, trimmed)', () => {
    expect(resolveEdition('hosted')).toBe('hosted');
    expect(resolveEdition('HOSTED')).toBe('hosted');
    expect(resolveEdition('  Hosted  ')).toBe('hosted');
  });

  it('falls back to community for unknown values', () => {
    expect(resolveEdition('enterprise')).toBe('community');
    expect(resolveEdition('paid')).toBe('community');
  });
});

describe('getEdition / isHosted', () => {
  const original = process.env.NEXUS_EDITION;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXUS_EDITION;
    else process.env.NEXUS_EDITION = original;
  });

  it('reads NEXUS_EDITION from the environment', () => {
    process.env.NEXUS_EDITION = 'hosted';
    expect(getEdition()).toBe('hosted');
    expect(isHosted()).toBe(true);

    process.env.NEXUS_EDITION = 'community';
    expect(getEdition()).toBe('community');
    expect(isHosted()).toBe(false);
  });

  it('isHosted honours an explicit edition argument', () => {
    expect(isHosted('hosted')).toBe(true);
    expect(isHosted('community')).toBe(false);
  });
});
