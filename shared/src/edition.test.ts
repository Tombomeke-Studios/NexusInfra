import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEditionIsRunnable,
  DEFAULT_EDITION,
  getBuildEdition,
  getEdition,
  isHosted,
  resolveEdition,
  resolveRuntimeEdition,
} from './edition.js';

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

  it('reads NEXUS_EDITION from the environment when running from source', () => {
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

// The rule these pin down: a released image decides its own edition, and the
// environment cannot talk it into being the other one (#189).

describe('getBuildEdition', () => {
  it('is null when there is no stamp — i.e. not a released image', () => {
    expect(getBuildEdition('/definitely/not/a/path/edition')).toBeNull();
  });
});

describe('resolveRuntimeEdition', () => {
  it('takes the image edition and says so', () => {
    expect(resolveRuntimeEdition({}, 'hosted')).toEqual({ edition: 'hosted', source: 'image' });
  });

  it('ignores an environment that agrees with the image', () => {
    expect(resolveRuntimeEdition({ NEXUS_EDITION: 'hosted' }, 'hosted')).toEqual({ edition: 'hosted', source: 'image' });
  });

  it('keeps the image edition and records the conflict when the environment disagrees', () => {
    // The whole point: pulling the community image and setting NEXUS_EDITION=hosted
    // must not produce a hosted service, because the hosted code isn't there.
    expect(resolveRuntimeEdition({ NEXUS_EDITION: 'hosted' }, 'community')).toEqual({
      edition: 'community',
      source: 'image',
      conflict: { requested: 'hosted', built: 'community' },
    });
  });

  it('lets the environment decide when running outside a released image', () => {
    // Development and tests run from source, where there is no stamp.
    expect(resolveRuntimeEdition({ NEXUS_EDITION: 'hosted' }, null)).toEqual({ edition: 'hosted', source: 'environment' });
    expect(resolveRuntimeEdition({ NEXUS_EDITION: 'community' }, null)).toEqual({ edition: 'community', source: 'environment' });
  });

  it('defaults to community when nothing says otherwise', () => {
    expect(resolveRuntimeEdition({}, null)).toEqual({ edition: 'community', source: 'default' });
  });

  it('treats an unrecognised environment value as unset rather than as community', () => {
    // Otherwise a typo would silently downgrade a hosted image.
    expect(resolveRuntimeEdition({ NEXUS_EDITION: 'enterprise' }, 'hosted')).toEqual({ edition: 'hosted', source: 'image' });
    expect(resolveRuntimeEdition({ NEXUS_EDITION: 'enterprise' }, null)).toEqual({ edition: 'community', source: 'default' });
  });
});

describe('assertEditionIsRunnable', () => {
  it('passes when the image and the environment agree, or the environment is silent', () => {
    expect(() => assertEditionIsRunnable({ edition: 'hosted', source: 'image' })).not.toThrow();
    expect(() => assertEditionIsRunnable({ edition: 'community', source: 'default' })).not.toThrow();
  });

  it('refuses a mismatch, naming both editions and the way out', () => {
    expect(() =>
      assertEditionIsRunnable({ edition: 'community', source: 'image', conflict: { requested: 'hosted', built: 'community' } })
    ).toThrow(/built for the community edition.*asks for hosted.*Use the :hosted image/s);
  });
});
