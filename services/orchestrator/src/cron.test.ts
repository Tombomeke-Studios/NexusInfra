import { describe, it, expect } from 'vitest';
import { cronMatches, isValidCron } from './cron.js';

// A fixed UTC instant: 2026-07-24 (Friday) 04:00.
const at = (iso: string) => new Date(iso);

describe('cronMatches', () => {
  it('matches an exact minute/hour ("0 4 * * *")', () => {
    expect(cronMatches('0 4 * * *', at('2026-07-24T04:00:00Z'))).toBe(true);
    expect(cronMatches('0 4 * * *', at('2026-07-24T04:01:00Z'))).toBe(false);
    expect(cronMatches('0 4 * * *', at('2026-07-24T05:00:00Z'))).toBe(false);
  });

  it('supports step values ("*/15")', () => {
    expect(cronMatches('*/15 * * * *', at('2026-07-24T04:30:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-07-24T04:20:00Z'))).toBe(false);
  });

  it('supports ranges and lists', () => {
    expect(cronMatches('0 9-17 * * *', at('2026-07-24T12:00:00Z'))).toBe(true);
    expect(cronMatches('0 9-17 * * *', at('2026-07-24T18:00:00Z'))).toBe(false);
    expect(cronMatches('0 0 1,15 * *', at('2026-07-15T00:00:00Z'))).toBe(true);
  });

  it('matches day-of-week (Monday = 1), treating 0 and 7 as Sunday', () => {
    // 2026-07-24 is a Friday (dow 5); 2026-07-27 is a Monday.
    expect(cronMatches('0 6 * * 1', at('2026-07-27T06:00:00Z'))).toBe(true);
    expect(cronMatches('0 6 * * 1', at('2026-07-24T06:00:00Z'))).toBe(false);
    expect(cronMatches('0 0 * * 7', at('2026-07-26T00:00:00Z'))).toBe(true); // Sunday via 7
    expect(cronMatches('0 0 * * 0', at('2026-07-26T00:00:00Z'))).toBe(true); // Sunday via 0
  });

  it('rejects malformed expressions', () => {
    expect(cronMatches('0 4 * *', at('2026-07-24T04:00:00Z'))).toBe(false); // 4 fields
  });
});

describe('isValidCron', () => {
  it('accepts well-formed 5-field expressions', () => {
    expect(isValidCron('0 4 * * *')).toBe(true);
    expect(isValidCron('*/5 0-12 1,15 * 1-5')).toBe(true);
  });
  it('rejects the wrong field count', () => {
    expect(isValidCron('0 4 * *')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });
});
