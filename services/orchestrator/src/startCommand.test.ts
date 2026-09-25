import { describe, it, expect } from 'vitest';
import { parsePersistPaths, persistPathsFor, startCommandFor } from './startCommand.js';
import type { ServerConfigRecord } from './types.js';

const base: ServerConfigRecord = {
  id: 'cfg',
  userId: 'u',
  teamId: null,
  name: 'My Server',
  dockerImage: 'nginx',
  ports: { '8080': '80' },
  env: { A: '1' },
  resourceLimits: { cpuPercent: 50 },
  autoRestart: false,
  dataPath: null,
  persistPaths: [],
  type: 'app',
  createdAt: '',
};

describe('persistPathsFor (#324)', () => {
  it("keeps an egg server's data directory", () => {
    expect(persistPathsFor({ ...base, type: 'minecraft-java' })).toEqual(['/data']);
  });

  it('adds the directories a plain application asked for', () => {
    expect(persistPathsFor({ ...base, persistPaths: ['/usr/share/nginx/html', '/etc/nginx'] })).toEqual(['/usr/share/nginx/html', '/etc/nginx']);
  });

  it('does not volume a directory that an imported host path already mounts (#268)', () => {
    expect(persistPathsFor({ ...base, type: 'minecraft-java', dataPath: '/srv/import/world' })).toEqual([]);
  });

  it('lists each directory once', () => {
    expect(persistPathsFor({ ...base, type: 'minecraft-java', persistPaths: ['/data', '/plugins'] })).toEqual(['/data', '/plugins']);
  });
});

describe('startCommandFor', () => {
  it('carries everything the agent needs, including what to persist', () => {
    const cmd = startCommandFor({ ...base, type: 'valheim' }, 'dep-1', 'node-a');
    expect(cmd).toEqual({
      deploymentId: 'dep-1',
      nodeId: 'node-a',
      dockerImage: 'nginx',
      containerName: expect.stringContaining('my-server'),
      env: { A: '1' },
      ports: { '8080': '80' },
      resourceLimits: { cpuPercent: 50 },
      persistPaths: ['/config'],
    });
  });

  it("keeps an imported server's mount — reconciliation used to drop it", () => {
    const cmd = startCommandFor({ ...base, type: 'minecraft-java', dataPath: '/srv/import/world' }, 'dep-1', 'node-a');
    expect(cmd.dataMount).toEqual({ hostPath: '/srv/import/world', containerPath: '/data' });
    expect(cmd.persistPaths).toEqual([]);
  });
});

describe('parsePersistPaths', () => {
  it('accepts absolute directories and normalises them', () => {
    expect(parsePersistPaths(['/data/', '/etc//nginx', '/data'])).toEqual({ ok: true, paths: ['/data', '/etc/nginx'] });
    expect(parsePersistPaths([])).toEqual({ ok: true, paths: [] });
  });

  it('refuses anything that is not a list of absolute paths', () => {
    for (const bad of ['/data', [1], ['data'], ['/'], ['/a/../etc'], ['/a:b'], [''], null]) {
      expect(parsePersistPaths(bad).ok).toBe(false);
    }
  });

  it('bounds how many a server can have', () => {
    expect(parsePersistPaths(Array.from({ length: 11 }, (_, i) => `/p${i}`)).ok).toBe(false);
  });
});
