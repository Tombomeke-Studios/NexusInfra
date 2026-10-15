import { describe, it, expect } from 'vitest';
import { nextNavFit } from './navFit';

describe('nextNavFit (#352)', () => {
  const full = { compact: false, neededWidth: null };

  it('keeps the full bar while its content fits', () => {
    expect(nextNavFit(full, { clientWidth: 1400, scrollWidth: 1400 })).toBe(full);
    // Sub-pixel rounding is not overflow.
    expect(nextNavFit(full, { clientWidth: 1400, scrollWidth: 1401 })).toBe(full);
  });

  it('folds as soon as the content is wider than the bar, and remembers how wide it was', () => {
    expect(nextNavFit(full, { clientWidth: 1000, scrollWidth: 1310 })).toEqual({ compact: true, neededWidth: 1310 });
  });

  it('stays folded until the remembered width is available again', () => {
    const folded = { compact: true, neededWidth: 1310 };
    // Folded, the content is small; that says nothing about the full bar.
    expect(nextNavFit(folded, { clientWidth: 1200, scrollWidth: 300 })).toBe(folded);
    expect(nextNavFit(folded, { clientWidth: 1310, scrollWidth: 300 })).toEqual({ compact: false, neededWidth: 1310 });
  });

  it('does not unfold without ever having measured the full bar', () => {
    const blind = { compact: true, neededWidth: null };
    expect(nextNavFit(blind, { clientWidth: 3000, scrollWidth: 100 })).toBe(blind);
  });
});
