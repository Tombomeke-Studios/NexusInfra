import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBackupRouter } from './bkRoutes.js';
import type { ContainerRuntime } from './runtime.js';

// A fake runtime that snapshots a fixed payload and records restore calls, so the
// router's file handling is tested against a real temp directory but no Docker.
class FakeRuntime implements Partial<ContainerRuntime> {
  payload = Buffer.from('tar-bytes');
  restored: Array<{ id: string; path: string; size: number }> = [];
  async snapshotPath(): Promise<Buffer> {
    return this.payload;
  }
  async restoreArchive(id: string, p: string, tar: Buffer): Promise<void> {
    this.restored.push({ id, path: p, size: tar.length });
  }
}

describe('backup router', () => {
  let runtime: FakeRuntime;
  let dir: string;
  let app: express.Express;

  beforeEach(async () => {
    runtime = new FakeRuntime();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusinfra-bk-test-'));
    app = express();
    app.use(express.json());
    app.use(createBackupRouter(runtime as unknown as ContainerRuntime, { dir }));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('snapshots to a tar on disk and round-trips through restore', async () => {
    const make = await request(app).post('/backups').send({ containerId: 'c1', path: '/data' });
    expect(make.status).toBe(201);
    expect(make.body.sizeBytes).toBe(runtime.payload.length);
    expect(make.body.path).toBe('/data');

    // The tar really exists on disk.
    const onDisk = await fs.readFile(path.join(dir, `${make.body.ref}.tar`));
    expect(onDisk.equals(runtime.payload)).toBe(true);

    // Restore reads it back and hands it to the runtime.
    const rest = await request(app).post('/backups/restore').send({ containerId: 'c1', ref: make.body.ref, path: '/data' });
    expect(rest.status).toBe(200);
    expect(runtime.restored).toEqual([{ id: 'c1', path: '/data', size: runtime.payload.length }]);

    // Delete removes the tar.
    expect((await request(app).delete(`/backups/${make.body.ref}`)).status).toBe(204);
    await expect(fs.access(path.join(dir, `${make.body.ref}.tar`))).rejects.toBeTruthy();
  });

  it('validates required fields and rejects an unsafe ref', async () => {
    expect((await request(app).post('/backups').send({})).status).toBe(400);
    expect((await request(app).post('/backups/restore').send({ containerId: 'c1' })).status).toBe(400);
    // A traversal ref never resolves to a real file → 400 on restore.
    expect((await request(app).post('/backups/restore').send({ containerId: 'c1', ref: '../evil' })).status).toBe(400);
  });
});
