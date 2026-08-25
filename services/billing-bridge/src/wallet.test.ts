import { describe, it, expect } from 'vitest';
import { applyCharge, applyTopUp, canCover } from './wallet.js';

describe('wallet math', () => {
  it('adds a top-up, rounded to cents', () => {
    expect(applyTopUp(10, 5.5)).toBe(15.5);
    expect(applyTopUp(0, 0.005)).toBe(0.01);
  });

  it('ignores negative top-ups', () => {
    expect(applyTopUp(10, -5)).toBe(10);
  });

  it('draws down for a charge and can go negative', () => {
    expect(applyCharge(10, 3)).toBe(7);
    expect(applyCharge(2, 5)).toBe(-3);
  });

  it('reports whether the balance covers a charge', () => {
    expect(canCover(10, 10)).toBe(true);
    expect(canCover(10, 11)).toBe(false);
  });
});
