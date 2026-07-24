import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFileRouter } from './fileRoutes.js';
import type { ContainerRuntime } from './runtime.js';
import type { FileEntry } from './files.js';

// A fake runtime that records file calls and can be scripted to fail, so the
// router's status-code mapping is tested without a Docker daemon.
class FakeRuntime implements Partial<ContainerRuntime> {
  calls: string[] = [];
  fail = false;
  entries: FileEntry[] = [{ name: 'src', kind: 'dir', size: 0 }];
  content = 'hello';

  async listFiles(id: string, path: string): Promise<FileEntry[]> {
    this.calls.push(`list:${id}:${path}`);
    if (this.fail) throw new Error('No such file or directory');
    return this.entries;
  }
  async readFile(id: string, path: string): Promise<string> {
    this.calls.push(`read:${id}:${path}`);
    return this.content;
  }
  async writeFile(id: string, path: string, content: string): Promise<void> {
    this.calls.push(`write:${id}:${path}:${content}`);
  }
  async makeDir(id: string, path: string): Promise<void> {
    this.calls.push(`mkdir:${id}:${path}`);
  }
  async renamePath(id: string, from: string, to: string): Promise<void> {
    this.calls.push(`rename:${id}:${from}:${to}`);
  }
  async deletePath(id: string, path: string): Promise<void> {
    this.calls.push(`delete:${id}:${path}`);
  }
}

describe('file router', () => {
  let runtime: FakeRuntime;
  let app: express.Express;

  beforeEach(() => {
    runtime = new FakeRuntime();
    app = express();
    app.use(express.json());
    app.use(createFileRouter(runtime as unknown as ContainerRuntime));
  });

  it('lists a directory', async () => {
    const res = await request(app).get('/files/c1').query({ path: '/app' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ name: 'src', kind: 'dir', size: 0 }]);
    expect(runtime.calls).toContain('list:c1:/app');
  });

  it('reads a file and returns its content', async () => {
    const res = await request(app).get('/files/c1/content').query({ path: '/app/x.txt' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: '/app/x.txt', content: 'hello' });
  });

  it('writes, makes dirs, renames and deletes', async () => {
    expect((await request(app).put('/files/c1/content').send({ path: '/app/y.txt', content: 'hi' })).status).toBe(204);
    expect((await request(app).post('/files/c1/dir').send({ path: '/app/new' })).status).toBe(201);
    expect((await request(app).post('/files/c1/rename').send({ from: '/a', to: '/b' })).status).toBe(200);
    expect((await request(app).delete('/files/c1').query({ path: '/app/y.txt' })).status).toBe(204);
    expect(runtime.calls).toEqual([
      'write:c1:/app/y.txt:hi',
      'mkdir:c1:/app/new',
      'rename:c1:/a:/b',
      'delete:c1:/app/y.txt',
    ]);
  });

  it('validates required params', async () => {
    expect((await request(app).get('/files/c1/content')).status).toBe(400);
    expect((await request(app).put('/files/c1/content').send({})).status).toBe(400);
    expect((await request(app).post('/files/c1/rename').send({ from: '/a' })).status).toBe(400);
  });

  it('maps a runtime failure to 400 with the message', async () => {
    runtime.fail = true;
    const res = await request(app).get('/files/c1').query({ path: '/nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No such file or directory');
  });
});
