import { describe, it, expect } from 'vitest';
import { isContained, resolveImportPath, importRoot, ImportPathError } from './imports.js';

// Bind-mounting a host directory into a container the user has a root shell in is
// a host takeover if it points at the wrong place (#268). These are the escapes
// the check has to survive.

describe('isContained', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(isContained('/srv/import', '/srv/import')).toBe(true);
    expect(isContained('/srv/import', '/srv/import/minecraft')).toBe(true);
    expect(isContained('/srv/import', '/srv/import/a/b/c')).toBe(true);
  });

  it('rejects a sibling that merely shares the prefix', () => {
    // The reason this compares segments rather than strings: '/srv/import-evil'
    // starts with '/srv/import' and is a different directory entirely.
    expect(isContained('/srv/import', '/srv/import-evil')).toBe(false);
    expect(isContained('/srv/import', '/srv/importer')).toBe(false);
  });

  it('rejects a parent, a sibling and the filesystem root', () => {
    expect(isContained('/srv/import', '/srv')).toBe(false);
    expect(isContained('/srv/import', '/etc')).toBe(false);
    expect(isContained('/srv/import', '/')).toBe(false);
  });

  it('rejects traversal', () => {
    expect(isContained('/srv/import', '/srv/import/../../etc')).toBe(false);
    expect(isContained('/srv/import', '/srv/import/../import-evil')).toBe(false);
  });
});

describe('resolveImportPath', () => {
  // A fake filesystem: a map of path → real path, so symlinks are expressible.
  const fs = (links: Record<string, string>) => ({
    realpath: async (p: string) => {
      if (p in links) return links[p];
      throw new Error('ENOENT');
    },
  });

  const ROOT = '/srv/import';
  const base = { '/srv/import': '/srv/import' };

  it('accepts a directory inside the root', async () => {
    const deps = { root: ROOT, ...fs({ ...base, '/srv/import/minecraft': '/srv/import/minecraft' }) };
    expect(await resolveImportPath('/srv/import/minecraft', deps)).toBe('/srv/import/minecraft');
  });

  it('is off unless a root is configured', async () => {
    await expect(resolveImportPath('/srv/import/mc', { ...fs(base) })).rejects.toThrow(/not enabled/);
  });

  // The case the whole module exists for: the string is inside the root, the
  // directory it resolves to is not. Checking before resolution would pass this.
  it('rejects a symlink that escapes the root', async () => {
    const deps = { root: ROOT, ...fs({ ...base, '/srv/import/escape': '/' }) };
    await expect(resolveImportPath('/srv/import/escape', deps)).rejects.toThrow(/outside the import root/);
  });

  it('rejects a symlink to the docker socket directory', async () => {
    const deps = { root: ROOT, ...fs({ ...base, '/srv/import/sock': '/var/run' }) };
    await expect(resolveImportPath('/srv/import/sock', deps)).rejects.toThrow(ImportPathError);
  });

  it('rejects traversal out of the root', async () => {
    const deps = { root: ROOT, ...fs({ ...base, '/srv/import/../../etc': '/etc' }) };
    await expect(resolveImportPath('/srv/import/../../etc', deps)).rejects.toThrow(/outside the import root/);
  });

  it('rejects a path that does not exist', async () => {
    await expect(resolveImportPath('/srv/import/missing', { root: ROOT, ...fs(base) })).rejects.toThrow(/does not exist/);
  });

  it('rejects a relative path', async () => {
    // It would otherwise resolve against the agent's working directory, which is
    // nobody's deliberate choice.
    await expect(resolveImportPath('../../etc', { root: ROOT, ...fs(base) })).rejects.toThrow(/absolute/);
  });

  it('rejects an empty path', async () => {
    await expect(resolveImportPath('   ', { root: ROOT, ...fs(base) })).rejects.toThrow(/required/);
  });

  it('explains a misconfigured root rather than blaming the request', async () => {
    const deps = { root: '/nope', ...fs({ '/srv/import/mc': '/srv/import/mc' }) };
    await expect(resolveImportPath('/srv/import/mc', deps)).rejects.toThrow(/import root \/nope does not exist/);
  });

  it('resolves the root through its own symlink before comparing', async () => {
    // /srv/import -> /mnt/data/import, so a real path under /mnt/data/import is
    // inside the root even though it shares no prefix with the configured value.
    const deps = {
      root: ROOT,
      ...fs({ '/srv/import': '/mnt/data/import', '/srv/import/mc': '/mnt/data/import/mc' }),
    };
    expect(await resolveImportPath('/srv/import/mc', deps)).toBe('/mnt/data/import/mc');
  });
});

describe('importRoot', () => {
  it('is undefined unless set, so the feature is off by default', () => {
    expect(importRoot({})).toBeUndefined();
    expect(importRoot({ IMPORT_ROOT: '   ' })).toBeUndefined();
    expect(importRoot({ IMPORT_ROOT: '/srv/import' })).toBe('/srv/import');
  });
});
