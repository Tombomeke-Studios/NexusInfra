import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDatabaseRouter } from './dbRoutes.js';
import type { ContainerRuntime, StartSpec } from './runtime.js';

// A fake runtime capturing start/stop, so the router is tested without Docker.
class FakeRuntime implements Partial<ContainerRuntime> {
  lastSpec: StartSpec | null = null;
  stopped: string[] = [];
  fail = false;
  async start(spec: StartSpec): Promise<string> {
    this.lastSpec = spec;
    if (this.fail) throw new Error('image pull failed');
    return 'db-container-1';
  }
  async stop(id: string): Promise<void> {
    this.stopped.push(id);
  }
}

describe('database router', () => {
  let runtime: FakeRuntime;
  let app: express.Express;

  beforeEach(() => {
    runtime = new FakeRuntime();
    app = express();
    app.use(express.json());
    app.use(createDatabaseRouter(runtime as unknown as ContainerRuntime, () => 33333));
  });

  it('provisions a database container and returns its id and port', async () => {
    const res = await request(app).post('/databases').send({ engine: 'postgres', name: 'app_db1', username: 'u', password: 'p' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ containerId: 'db-container-1', port: 33333 });
    expect(runtime.lastSpec?.dockerImage).toBe('postgres:16');
    expect(runtime.lastSpec?.ports).toEqual({ '33333': '5432' });
  });

  it('rejects an unknown engine or missing credentials', async () => {
    expect((await request(app).post('/databases').send({ engine: 'mongo', name: 'd', username: 'u', password: 'p' })).status).toBe(400);
    expect((await request(app).post('/databases').send({ engine: 'mysql', name: 'd' })).status).toBe(400);
  });

  it('deprovisions by stopping the container', async () => {
    const res = await request(app).delete('/databases/db-container-1');
    expect(res.status).toBe(204);
    expect(runtime.stopped).toEqual(['db-container-1']);
  });

  it('maps a runtime start failure to 400', async () => {
    runtime.fail = true;
    const res = await request(app).post('/databases').send({ engine: 'mysql', name: 'd', username: 'u', password: 'p' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('image pull failed');
  });
});
