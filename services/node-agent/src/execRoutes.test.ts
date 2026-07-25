import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createExecRouter } from './execRoutes.js';
import type { ContainerRuntime } from './runtime.js';

class FakeRuntime implements Partial<ContainerRuntime> {
  lastCmd: string[] | null = null;
  fail = false;
  async execCommand(id: string, cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.lastCmd = cmd;
    if (this.fail) throw new Error('no such container');
    return { stdout: 'file1\nfile2\n', stderr: '', exitCode: 0 };
  }
}

describe('exec router', () => {
  let runtime: FakeRuntime;
  let app: express.Express;

  beforeEach(() => {
    runtime = new FakeRuntime();
    app = express();
    app.use(express.json());
    app.use(createExecRouter(runtime as unknown as ContainerRuntime));
  });

  it('runs the command via sh -c and returns its output', async () => {
    const res = await request(app).post('/exec/c1').send({ command: 'ls' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stdout: 'file1\nfile2\n', stderr: '', exitCode: 0 });
    expect(runtime.lastCmd).toEqual(['sh', '-c', 'ls']);
  });

  it('rejects an empty command', async () => {
    expect((await request(app).post('/exec/c1').send({ command: '   ' })).status).toBe(400);
    expect((await request(app).post('/exec/c1').send({})).status).toBe(400);
  });

  it('maps a runtime failure to 400', async () => {
    runtime.fail = true;
    const res = await request(app).post('/exec/c1').send({ command: 'ls' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no such container');
  });
});
