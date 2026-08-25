import { describe, it, expect } from 'vitest';
import { hexToRgb } from './fx';

describe('hexToRgb', () => {
  it('parses #rrggbb into an "r,g,b" string', () => {
    expect(hexToRgb('#4f46e5')).toBe('79,70,229');
    expect(hexToRgb('4f46e5')).toBe('79,70,229'); // hash optional
  });

  it('expands the #rgb shorthand', () => {
    expect(hexToRgb('#fff')).toBe('255,255,255');
    expect(hexToRgb('#000')).toBe('0,0,0');
  });

  it('returns null for malformed input', () => {
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb('#12')).toBeNull();
    expect(hexToRgb('#zzzzzz')).toBeNull();
  });
});
