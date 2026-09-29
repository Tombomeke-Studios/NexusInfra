import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDataRouter, pathsToPersist, volumeMounts, volumeNameFor, DEPLOYMENT_LABEL } from './volumes.js';
import type { ContainerRuntime } from './runtime.js';

describe('volumeNameFor (#324)', () => {
  it('is deterministic, so the next container finds the same volume', () => {
    expect(volumeNameFor('dep-1', '/data')).toBe(volumeNameFor('dep-1', '/data'));
  });

  it('is a valid Docker volume name that says whose and what it is', () => {
    const name = volumeNameFor('3f2a9c1e-aaaa-bbbb-cccc-1234567890ab', '/home/steam/cs2-dedicated');
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    expect(name).toContain('3f2a9c1e');
    expect(name).toContain('home-steam-cs2-dedicated');
  });

  it('keeps two paths that slug alike apart', () => {
    expect(volumeNameFor('d', '/a-b')).not.toBe(volumeNameFor('d', '/a/b'));
  });

  it('keeps two servers apart', () => {
    expect(volumeNameFor('d1', '/data')).not.toBe(volumeNameFor('d2', '/data'));
  });
});

describe('pathsToPersist', () => {
  it('persists what was asked for plus what the image declares', () => {
    expect(pathsToPersist({ requested: ['/data'], imageVolumes: ['/var/lib/mysql'] })).toEqual(['/data', '/var/lib/mysql']);
  });

  it('lists a directory once, however it was spelled', () => {
    expect(pathsToPersist({ requested: ['/data/', '/data'], imageVolumes: ['/data'] })).toEqual(['/data']);
  });

  it('leaves an imported directory to its bind mount, including anything under it (#268)', () => {
    expect(pathsToPersist({ requested: ['/data', '/plugins'], imageVolumes: ['/data/logs'], dataMountPath: '/data' })).toEqual(['/plugins']);
  });

  it('ignores anything that is not an absolute directory', () => {
    expect(pathsToPersist({ requested: ['relative', '/', ''], imageVolumes: [] })).toEqual([]);
  });
});

describe('volumeMounts', () => {
  it('mounts one named volume per directory', () => {
    expect(volumeMounts('d', ['/data'])).toEqual([{ Type: 'volume', Source: volumeNameFor('d', '/data'), Target: '/data' }]);
  });
});

describe('data router', () => {
  it("removes a deleted server's containers and volumes", async () => {
    const calls: string[] = [];
    const runtime = {
      purgeDeployment: async (id: string) => {
        calls.push(id);
        return { containers: 1, volumes: 2 };
      },
    } as unknown as ContainerRuntime;
    const app = express().use(createDataRouter(runtime));

    const res = await request(app).delete('/deployments/dep-1/data');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ containers: 1, volumes: 2 });
    expect(calls).toEqual(['dep-1']);
  });

  it('refuses an id that could not have come from the orchestrator', async () => {
    const runtime = { purgeDeployment: async () => ({ containers: 0, volumes: 0 }) } as unknown as ContainerRuntime;
    const app = express().use(createDataRouter(runtime));
    await request(app).delete('/deployments/a%20b/data').expect(400);
  });

  it('labels with a stable key', () => {
    expect(DEPLOYMENT_LABEL).toBe('nexusinfra.deployment');
  });
});
