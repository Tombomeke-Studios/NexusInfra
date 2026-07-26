import { describe, it, expect } from 'vitest';
import { accruedHours, hoursBetween } from './tracking.js';

describe('hoursBetween', () => {
  it('measures fractional hours', () => {
    expect(hoursBetween('2026-07-01T00:00:00.000Z', '2026-07-01T01:30:00.000Z')).toBe(1.5);
  });

  it('is zero for reversed or equal timestamps', () => {
    expect(hoursBetween('2026-07-01T02:00:00.000Z', '2026-07-01T01:00:00.000Z')).toBe(0);
    expect(hoursBetween('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')).toBe(0);
  });
});

describe('accruedHours', () => {
  it('sums closed intervals', () => {
    const hours = accruedHours([
      { startedAt: '2026-07-01T00:00:00.000Z', stoppedAt: '2026-07-01T02:00:00.000Z' },
      { startedAt: '2026-07-02T00:00:00.000Z', stoppedAt: '2026-07-02T01:00:00.000Z' },
    ]);
    expect(hours).toBe(3);
  });

  it('counts an open interval up to now', () => {
    const hours = accruedHours(
      [{ startedAt: '2026-07-01T00:00:00.000Z', stoppedAt: null }],
      '2026-07-01T04:00:00.000Z'
    );
    expect(hours).toBe(4);
  });
});
