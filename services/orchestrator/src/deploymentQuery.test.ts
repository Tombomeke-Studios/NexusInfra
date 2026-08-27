import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  matchesFilter,
  pageOf,
  parseFilter,
  parsePage,
  UNASSIGNED,
  type FilterableDeployment,
} from './deploymentQuery.js';

const row = (over: Partial<FilterableDeployment> & { id: string }): FilterableDeployment => ({
  name: over.id,
  status: 'running',
  nodeId: 'node-a',
  userId: 'user-1',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('parsePage', () => {
  it('applies a limit whether or not one was asked for', () => {
    // An unbounded list is the thing this exists to prevent.
    expect(parsePage({})).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it('caps the limit, so nobody can ask for everything after all', () => {
    expect(parsePage({ limit: '100000' }).limit).toBe(MAX_LIMIT);
    expect(parsePage({ limit: '10' }).limit).toBe(10);
  });

  it('refuses a limit of zero rather than returning nothing forever', () => {
    expect(parsePage({ limit: '0' }).limit).toBe(1);
    expect(parsePage({ limit: '-5' }).limit).toBe(DEFAULT_LIMIT);
  });

  it('falls back on nonsense instead of failing', () => {
    expect(parsePage({ limit: 'lots', offset: 'later' })).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });
});

describe('parseFilter', () => {
  it('reads the filters it knows and ignores the rest', () => {
    // A stale bookmark naming a filter we have since dropped should still show
    // the person their servers.
    expect(parseFilter({ q: ' web ', status: 'running', colour: 'blue' })).toEqual({
      q: 'web',
      status: 'running',
      nodeId: undefined,
      ownerId: undefined,
    });
  });

  it('treats blank as absent', () => {
    expect(parseFilter({ q: '   ', status: '' })).toEqual({ q: undefined, status: undefined, nodeId: undefined, ownerId: undefined });
  });
});

describe('matchesFilter', () => {
  const web = row({ id: 'a', name: 'Web Front End', status: 'running', nodeId: 'node-a', userId: 'user-1' });

  it('searches the name case-insensitively, anywhere in it', () => {
    expect(matchesFilter(web, { q: 'front' })).toBe(true);
    expect(matchesFilter(web, { q: 'WEB' })).toBe(true);
    expect(matchesFilter(web, { q: 'database' })).toBe(false);
  });

  it('matches status, node and owner exactly', () => {
    expect(matchesFilter(web, { status: 'running' })).toBe(true);
    expect(matchesFilter(web, { status: 'stopped' })).toBe(false);
    expect(matchesFilter(web, { nodeId: 'node-a' })).toBe(true);
    expect(matchesFilter(web, { nodeId: 'node-b' })).toBe(false);
    expect(matchesFilter(web, { ownerId: 'user-1' })).toBe(true);
    expect(matchesFilter(web, { ownerId: 'user-2' })).toBe(false);
  });

  it('can ask for the servers that landed nowhere', () => {
    // Which is exactly the list somebody goes looking for when placement failed.
    const orphan = row({ id: 'b', nodeId: null });
    expect(matchesFilter(orphan, { nodeId: UNASSIGNED })).toBe(true);
    expect(matchesFilter(web, { nodeId: UNASSIGNED })).toBe(false);
  });

  it('combines filters as "and"', () => {
    expect(matchesFilter(web, { q: 'web', status: 'running' })).toBe(true);
    expect(matchesFilter(web, { q: 'web', status: 'stopped' })).toBe(false);
  });

  it('matches everything with no filter at all', () => {
    expect(matchesFilter(web, {})).toBe(true);
  });
});

describe('pageOf', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    row({ id: `d${i}`, name: `server-${i}`, createdAt: `2026-08-0${i + 1}T00:00:00.000Z` })
  );

  it('counts what matched, not what it returned', () => {
    // Otherwise a page cannot tell the caller there is more, which is the whole
    // difference between paging and silently truncating.
    const page = pageOf(rows, {}, { limit: 3, offset: 0 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(7);
  });

  it('returns newest first', () => {
    expect(pageOf(rows, {}, { limit: 2, offset: 0 }).items.map((r) => r.id)).toEqual(['d6', 'd5']);
  });

  it('walks every row exactly once across pages', () => {
    // A partial order lets two rows swap between requests, which shows one twice
    // and hides the other entirely.
    const seen: string[] = [];
    for (let offset = 0; offset < 7; offset += 3) seen.push(...pageOf(rows, {}, { limit: 3, offset }).items.map((r) => r.id));
    expect(new Set(seen).size).toBe(7);
  });

  it('breaks a tie on created time by id, so the order is total', () => {
    const same = [row({ id: 'b', createdAt: 'x' }), row({ id: 'a', createdAt: 'x' })];
    expect(pageOf(same, {}, { limit: 10, offset: 0 }).items.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('counts after filtering, not before', () => {
    const mixed = [...rows, row({ id: 'z', name: 'database', createdAt: '2026-08-09T00:00:00.000Z' })];
    const page = pageOf(mixed, { q: 'server' }, { limit: 10, offset: 0 });
    expect(page.total).toBe(7);
    expect(page.items.some((r) => r.id === 'z')).toBe(false);
  });

  it('answers an offset past the end with nothing, not with the last page', () => {
    const page = pageOf(rows, {}, { limit: 3, offset: 99 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(7);
  });
});
