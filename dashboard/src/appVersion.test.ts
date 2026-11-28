import { describe, it, expect } from 'vitest';
import { APP_VERSION, isStaleBundle } from './appVersion';

describe('isStaleBundle (#447)', () => {
  it('is the version the build baked in', () => {
    expect(APP_VERSION).toBe('0.5.0-test');
  });

  it('says reload only when both sides name a real, different release', () => {
    expect(isStaleBundle('0.5.0', '0.5.1')).toBe(true);
    expect(isStaleBundle('0.5.0', '0.5.0')).toBe(false);
    expect(isStaleBundle('0.5.0', null)).toBe(false);
    expect(isStaleBundle('0.0.0-dev', '0.5.1')).toBe(false);
    expect(isStaleBundle('0.5.0', '0.0.0-dev')).toBe(false);
  });
});
