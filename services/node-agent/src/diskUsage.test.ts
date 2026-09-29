import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDiskUsageCache, createDiskUsageRouter, diskByDeployment, totalBytes, type DockerDf } from './diskUsage.js';

// #347: which server is filling the disk.

const vol = (name: string, deployment: string | null, size: number, path = '/data') => ({
  Name: name,
  Labels: deployment ? { 'nexusinfra.deployment': deployment, 'nexusinfra.path': path } : { 'com.docker.volume.anonymous': '' },
  UsageData: { Size: size },
});
const ctr = (deployment: string | null, sizeRw?: number) => ({ Labels: deployment ? { 'nexusinfra.deployment': deployment } : {}, SizeRw: sizeRw });

describe('diskByDeployment', () => {
  it('adds up each server’s volumes and writable layer', () => {
    const df: DockerDf = {
      Volumes: [vol('v1', 'a', 1000, '/data'), vol('v2', 'a', 500, '/plugins'), vol('v3', 'b', 42)],
      Containers: [ctr('a', 200), ctr('b', 0)],
    };
    const by = diskByDeployment(df);
    expect(by.get('a')).toEqual({
      deploymentId: 'a',
      volumesBytes: 1500,
      writableBytes: 200,
      volumes: [
        { name: 'v1', path: '/data', bytes: 1000 },
        { name: 'v2', path: '/plugins', bytes: 500 },
      ],
    });
    expect(totalBytes(by.get('a')!)).toBe(1700);
    expect(by.get('b')).toMatchObject({ volumesBytes: 42, writableBytes: 0 });
  });

  it('ignores what the panel does not own', () => {
    const by = diskByDeployment({ Volumes: [vol('anon', null, 9999)], Containers: [ctr(null, 5)] });
    expect(by.size).toBe(0);
  });

  it('keeps an unmeasured volume unknown rather than calling it empty', () => {
    // Docker says -1 when it could not measure. A partial sum would understate
    // exactly the server somebody is trying to find.
    const by = diskByDeployment({ Volumes: [vol('v1', 'a', 1000), vol('v2', 'a', -1)], Containers: [ctr('a', -1)] });
    expect(by.get('a')).toMatchObject({ volumesBytes: null, writableBytes: null });
    expect(totalBytes(by.get('a')!)).toBeNull();
  });

  it('knows a stopped server has no writable layer to report', () => {
    const by = diskByDeployment({ Volumes: [vol('v1', 'a', 10)], Containers: [] });
    expect(by.get('a')).toMatchObject({ volumesBytes: 10, writableBytes: null });
    expect(totalBytes(by.get('a')!)).toBe(10);
  });
});

describe('createDiskUsageCache', () => {
  it('walks the volumes once per minute however many ask, including at the same moment', async () => {
    let walks = 0;
    let clock = 0;
    const measure = createDiskUsageCache(async () => (walks++, { Volumes: [], Containers: [] }), { ttlMs: 60_000, now: () => clock });
    await Promise.all([measure(), measure(), measure()]);
    expect(walks).toBe(1);
    clock = 59_000;
    await measure();
    expect(walks).toBe(1);
    clock = 61_000;
    await measure();
    expect(walks).toBe(2);
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const measure = createDiskUsageCache(async () => {
      if (fail) throw new Error('docker busy');
      return { Volumes: [vol('v', 'a', 1)] };
    });
    await expect(measure()).rejects.toThrow('docker busy');
    fail = false;
    expect((await measure()).byDeployment.get('a')?.volumesBytes).toBe(1);
  });
});

describe('disk usage routes', () => {
  const df: DockerDf = { Volumes: [vol('small', 'a', 10), vol('big', 'b', 5000)], Containers: [ctr('a', 1), ctr('b', 1)] };
  const app = express().use(createDiskUsageRouter(createDiskUsageCache(async () => df, { now: () => Date.UTC(2026, 8, 25) })));

  it('lists the node’s servers largest first', async () => {
    const res = await request(app).get('/disk');
    expect(res.body.measuredAt).toBe('2026-09-25T00:00:00.000Z');
    expect(res.body.deployments.map((d: { deploymentId: string }) => d.deploymentId)).toEqual(['b', 'a']);
  });

  it('answers for one server, and for one with nothing here', async () => {
    expect((await request(app).get('/deployments/b/disk')).body).toMatchObject({ volumesBytes: 5000, writableBytes: 1 });
    expect((await request(app).get('/deployments/zzz/disk')).body).toMatchObject({ volumesBytes: 0, writableBytes: null, volumes: [] });
  });

  it('says so when Docker cannot measure', async () => {
    const broken = express().use(createDiskUsageRouter(createDiskUsageCache(async () => Promise.reject(new Error('timeout')))));
    const res = await request(broken).get('/disk');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/could not measure/);
  });
});
