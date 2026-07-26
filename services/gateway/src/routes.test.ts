import { describe, it, expect } from 'vitest';
import { defaultRoutes, matchRoute, prefixMatches } from './routes.js';

const routes = defaultRoutes('http://orchestrator:9200');

describe('prefixMatches', () => {
  it('matches the exact prefix or a deeper path', () => {
    expect(prefixMatches('/nodes', '/nodes')).toBe(true);
    expect(prefixMatches('/nodes/abc', '/nodes')).toBe(true);
  });
  it('does not match a different segment with the same start', () => {
    expect(prefixMatches('/nodesX', '/nodes')).toBe(false);
    expect(prefixMatches('/node', '/nodes')).toBe(false);
  });
});

describe('matchRoute', () => {
  it('routes protected API paths to the orchestrator', () => {
    expect(matchRoute('/deployments', routes)).toEqual({ target: 'http://orchestrator:9200', public: false });
    expect(matchRoute('/deployments/d1/logs', routes)).toEqual({ target: 'http://orchestrator:9200', public: false });
  });

  it('marks login and config as public', () => {
    expect(matchRoute('/auth/login', routes)?.public).toBe(true);
    expect(matchRoute('/config', routes)?.public).toBe(true);
  });

  it('marks billing/monitoring as protected', () => {
    expect(matchRoute('/billing/wallet', routes)?.public).toBe(false);
    expect(matchRoute('/monitoring', routes)?.public).toBe(false);
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute('/nope', routes)).toBeNull();
  });

  it('prefers the longest matching prefix', () => {
    const custom = [
      { prefix: '/a', target: 'x' },
      { prefix: '/a/b', target: 'y' },
    ];
    expect(matchRoute('/a/b/c', custom)?.target).toBe('y');
  });
});
