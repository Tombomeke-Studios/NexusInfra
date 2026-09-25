import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBackupRouter } from './bkRoutes.js';
import type { ContainerRuntime } from './runtime.js';
import type { S3Target } from './s3.js';

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
    app.use(createBackupRouter(runtime as unknown as ContainerRuntime, { dir, offsite: null }));
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

  it('downloads a backup as a tar (#232)', async () => {
    const make = await request(app).post('/backups').send({ containerId: 'c1', path: '/data' });
    const res = await request(app).get(`/backups/${make.body.ref}/download`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-tar');
    expect((res.body as Buffer).equals(runtime.payload)).toBe(true);
    expect((await request(app).get('/backups/bk_missing/download')).status).toBe(404);
    expect((await request(app).get('/backups/..%2Fevil/download')).status).toBe(400);
  });

  describe('off-site copies (#232)', () => {
    class FakeBucket {
      objects = new Map<string, Buffer>();
      failPut = false;
      async put(ref: string, tar: Buffer) {
        if (this.failPut) throw new Error('off-site upload failed (403 AccessDenied)');
        this.objects.set(ref, tar);
      }
      async get(ref: string) {
        return this.objects.get(ref) ?? null;
      }
      async delete(ref: string) {
        this.objects.delete(ref);
      }
    }
    let bucket: FakeBucket;
    let offApp: express.Express;

    beforeEach(() => {
      bucket = new FakeBucket();
      offApp = express();
      offApp.use(express.json());
      offApp.use(createBackupRouter(runtime as unknown as ContainerRuntime, { dir, offsite: bucket as unknown as S3Target }));
    });

    it('copies each backup off the node and says so', async () => {
      const make = await request(offApp).post('/backups').send({ containerId: 'c1', path: '/data' });
      expect(make.body.offsite).toBe('stored');
      expect(bucket.objects.get(make.body.ref)?.equals(runtime.payload)).toBe(true);
    });

    it('keeps the backup when the upload fails, and records that it is only on the node', async () => {
      bucket.failPut = true;
      const make = await request(offApp).post('/backups').send({ containerId: 'c1', path: '/data' });
      expect(make.status).toBe(201);
      expect(make.body).toMatchObject({ offsite: 'failed', offsiteError: expect.stringContaining('AccessDenied') });
      await expect(fs.access(path.join(dir, `${make.body.ref}.tar`))).resolves.toBeUndefined();
    });

    it('restores from off-site when the node lost its copy — the reason off-site exists', async () => {
      const make = await request(offApp).post('/backups').send({ containerId: 'c1', path: '/data' });
      await fs.rm(path.join(dir, `${make.body.ref}.tar`));

      const rest = await request(offApp).post('/backups/restore').send({ containerId: 'c1', ref: make.body.ref, path: '/data' });
      expect(rest.status).toBe(200);
      expect(runtime.restored).toEqual([{ id: 'c1', path: '/data', size: runtime.payload.length }]);
    });

    it('deletes the off-site copy with the backup', async () => {
      const make = await request(offApp).post('/backups').send({ containerId: 'c1', path: '/data' });
      await request(offApp).delete(`/backups/${make.body.ref}`).expect(204);
      expect(bucket.objects.has(make.body.ref)).toBe(false);
    });
  });
});
