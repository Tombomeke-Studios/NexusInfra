import { describe, expect, it } from 'vitest';
import { DEV_VERSION, getVersion } from './version.js';

describe('getVersion', () => {
  it('prefers APP_VERSION, which the release build bakes in', () => {
    expect(getVersion({ APP_VERSION: '1.4.0', npm_package_version: '0.1.0' })).toBe('1.4.0');
  });

  it('falls back to the npm-provided version when APP_VERSION is unset', () => {
    expect(getVersion({ npm_package_version: '0.1.0' })).toBe('0.1.0');
  });

  it('ignores a blank APP_VERSION rather than reporting an empty version', () => {
    expect(getVersion({ APP_VERSION: '   ', npm_package_version: '0.1.0' })).toBe('0.1.0');
  });

  it('reports the dev placeholder when nothing is set', () => {
    expect(getVersion({})).toBe(DEV_VERSION);
  });
});
