import { describe, it, expect, beforeEach } from 'vitest';
import { getPrefs, setPrefs, hasSeenIntro, markIntroSeen, getDeploymentDefaults, setDeploymentDefaults, resetDeploymentDefaults, DEFAULT_DEPLOYMENT } from './prefs';

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

  it('returns the built-in deployment defaults until overridden', () => {
    expect(getDeploymentDefaults()).toEqual(DEFAULT_DEPLOYMENT);
  });

  it('merges deployment-default overrides over the built-ins', () => {
    setDeploymentDefaults({ cpu: 80, dbEngine: 'postgres' });
    const d = getDeploymentDefaults();
    expect(d.cpu).toBe(80);
    expect(d.dbEngine).toBe('postgres');
    expect(d.ram).toBe(DEFAULT_DEPLOYMENT.ram); // untouched fields keep the built-in
    // A second patch merges rather than replacing.
    setDeploymentDefaults({ ram: 65 });
    expect(getDeploymentDefaults().cpu).toBe(80);
    expect(getDeploymentDefaults().ram).toBe(65);
  });

  it('resets deployment defaults back to the built-ins', () => {
    setDeploymentDefaults({ cpu: 90 });
    resetDeploymentDefaults();
    expect(getDeploymentDefaults()).toEqual(DEFAULT_DEPLOYMENT);
  });
});
