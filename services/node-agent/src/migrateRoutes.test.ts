import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMigrationRouter } from './migrateRoutes.js';
import type { ContainerRuntime } from './runtime.js';

class FakeRuntime {
  volumes: Array<{ name: string; path: string }> = [{ name: 'nexus-d1-data', path: '/data' }];
  imported: Array<{ id: string; path: string; image: string; bytes: string }> = [];
  removed: string[] = [];
  existing = new Set<string>();
  async listDeploymentVolumes() {
    return this.volumes;
  }
  async exportVolume(_id: string, p: string) {
    return Readable.from([Buffer.from(`tar-of-${p}`)]);
  }
  async importVolume(id: string, p: string, image: string, tar: NodeJS.ReadableStream) {
    if (this.existing.has(p)) throw Object.assign(new Error('this node already holds that volume'), { code: 'EEXIST' });
    const chunks: Buffer[] = [];
    for await (const c of tar as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    this.imported.push({ id, path: p, image, bytes: Buffer.concat(chunks).toString() });
  }
  async removeDeploymentVolume(_id: string, p: string) {
    this.removed.push(p);
  }
}

describe('migration router (#234)', () => {
  let runtime: FakeRuntime;
  let dir: string;
  let app: express.Express;

  beforeEach(async () => {
    runtime = new FakeRuntime();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexusinfra-mig-'));
    app = express().use(createMigrationRouter(runtime as unknown as ContainerRuntime, { backupDir: dir }));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("lists a server's volumes", async () => {
    const res = await request(app).get('/deployments/d1/volumes');
    expect(res.body).toEqual([{ name: 'nexus-d1-data', path: '/data' }]);
  });

  it('exports a volume as a tar stream', async () => {
    const res = await request(app).get('/deployments/d1/volumes/export').query({ path: '/data', image: 'nginx' }).buffer(true).parse((r, cb) => {
      const c: Buffer[] = [];
      r.on('data', (x: Buffer) => c.push(x));
      r.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('tar-of-/data');
  });

  it('imports a streamed tar into a new volume', async () => {
    const res = await request(app)
      .put('/deployments/d1/volumes/import')
      .query({ path: '/data', image: 'nginx' })
      .set('content-type', 'application/x-tar')
      .send(Buffer.from('world-bytes'));
    expect(res.status).toBe(201);
    expect(runtime.imported).toEqual([{ id: 'd1', path: '/data', image: 'nginx', bytes: 'world-bytes' }]);
  });

  it('refuses to import over a volume this node already has — two agents on one daemon would lose the source', async () => {
    runtime.existing.add('/data');
    const res = await request(app).put('/deployments/d1/volumes/import').query({ path: '/data', image: 'nginx' }).set('content-type', 'application/x-tar').send(Buffer.from('x'));
    expect(res.status).toBe(409);
  });

  it('removes one volume, for an aborted migration', async () => {
    await request(app).delete('/deployments/d1/volumes').query({ path: '/data' }).expect(204);
    expect(runtime.removed).toEqual(['/data']);
  });

  it('needs a path and an image, and a plausible id', async () => {
    await request(app).get('/deployments/d1/volumes/export').query({ path: '/data' }).expect(400);
    await request(app).get('/deployments/d1/volumes/export').query({ path: 'rel', image: 'nginx' }).expect(400);
    await request(app).get('/deployments/a%20b/volumes').expect(400);
  });

  it('receives a backup tar, and never over one it already has', async () => {
    await request(app).put('/backups/bk_1').set('content-type', 'application/x-tar').send(Buffer.from('tar')).expect(201);
    expect((await fs.readFile(path.join(dir, 'bk_1.tar'))).toString()).toBe('tar');
    await request(app).put('/backups/bk_1').set('content-type', 'application/x-tar').send(Buffer.from('other')).expect(409);
    expect((await fs.readFile(path.join(dir, 'bk_1.tar'))).toString()).toBe('tar');
    await request(app).put('/backups/..%2Fx').set('content-type', 'application/x-tar').send(Buffer.from('x')).expect(400);
  });
});
