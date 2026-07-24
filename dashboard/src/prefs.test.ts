import { describe, it, expect, beforeEach } from 'vitest';
import { getPrefs, setPrefs, hasSeenIntro, markIntroSeen } from './prefs';

describe('prefs', () => {
  beforeEach(() => localStorage.clear());

  it('returns an empty object before anything is stored', () => {
    expect(getPrefs()).toEqual({});
    expect(hasSeenIntro()).toBe(false);
  });

  it('merges patches rather than overwriting', () => {
    setPrefs({ introSeen: true });
    setPrefs({});
    expect(getPrefs()).toEqual({ introSeen: true });
  });

  it('records the intro as seen', () => {
    markIntroSeen();
    expect(hasSeenIntro()).toBe(true);
  });

  it('tolerates a corrupt prefs blob', () => {
    localStorage.setItem('nexusinfra.prefs', '{not json');
    expect(getPrefs()).toEqual({});
  });
});
