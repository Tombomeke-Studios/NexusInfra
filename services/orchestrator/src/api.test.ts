import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createApiRouter } from './api.js';

// API tests use a real Express app with the in-memory repo and a captured
// publisher, so no broker or database is needed. The key assertion is that
// creating a deployment emits infra.server.start for the chosen node.

function buildApp(repo: InMemoryRepository, published: Array<{ key: string; envelope: EventEnvelope }>) {
  const app = express();
  app.use(express.json());
  app.use(
    createApiRouter({
      repo,
      publish: async (key, envelope) => {
        published.push({ key, envelope });
        return true;
      },
    })
  );
  return app;
}

async function seedHealthyNode(repo: InMemoryRepository, id = 'node-local') {
  await repo.upsertNode({ id, name: id, lastHeartbeat: new Date().toISOString(), cpuPercent: 10, ramUsedMb: 1000, ramTotalMb: 8000 });
}

describe('deployment API', () => {
  let repo: InMemoryRepository;
  let published: Array<{ key: string; envelope: EventEnvelope }>;
  let app: express.Express;

  beforeEach(() => {
    repo = new InMemoryRepository();
    published = [];
    app = buildApp(repo, published);
  });

  it('creates a deployment and emits server.start for the chosen node', async () => {
    await seedHealthyNode(repo);

    const res = await request(app)
      .post('/deployments')
      .send({ name: 'my-nginx', dockerImage: 'nginx', ports: { '8080': '80' } });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-nginx');
    expect(res.body.status).toBe('pending');
    expect(res.body.nodeId).toBe('node-local');

    const start = published.find((p) => p.key === 'infra.server.start');
    expect(start).toBeDefined();
    const payload = readPayload(start!.envelope.event) as Record<string, unknown>;
    expect(payload.nodeId).toBe('node-local');
    expect(payload.dockerImage).toBe('nginx');
    expect(payload.deploymentId).toBe(res.body.id);
  });

  it('persists the resource limits, restart flag and kind from the request', async () => {
    await seedHealthyNode(repo);

    const res = await request(app)
      .post('/deployments')
      .send({
        name: 'capped',
        dockerImage: 'nginx',
        type: 'game',
        autoRestart: true,
        resourceLimits: { cpuPercent: 40, ramPercent: 60, restartPolicy: 'on-failure', oomKill: true },
      });

    expect(res.status).toBe(201);
    const config = await repo.getDeploymentConfig(res.body.id);
    expect(config?.type).toBe('game');
    expect(config?.autoRestart).toBe(true);
    expect(config?.resourceLimits).toEqual({ cpuPercent: 40, ramPercent: 60, restartPolicy: 'on-failure', oomKill: true });
  });

  it('rejects a deployment with missing fields', async () => {
    await seedHealthyNode(repo);
    const res = await request(app).post('/deployments').send({ name: 'no-image' });
    expect(res.status).toBe(400);
    expect(published).toHaveLength(0);
  });

  it('returns 503 when no healthy node is available', async () => {
    const res = await request(app).post('/deployments').send({ name: 'x', dockerImage: 'nginx' });
    expect(res.status).toBe(503);
    expect(published).toHaveLength(0);
  });

  it('lists deployments and exposes node health', async () => {
    await seedHealthyNode(repo);
    await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

    const list = await request(app).get('/deployments');
    expect(list.body).toHaveLength(1);

    const nodes = await request(app).get('/nodes');
    expect(nodes.body[0].health).toBe('healthy');
  });

  it('stops a running deployment by emitting server.stop', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    // Simulate the agent report that marks it running with a container id.
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc123' });

    const res = await request(app).post(`/deployments/${created.body.id}/stop`);
    expect(res.status).toBe(202);

    const stop = published.find((p) => p.key === 'infra.server.stop');
    expect(stop).toBeDefined();
    const payload = readPayload(stop!.envelope.event) as Record<string, unknown>;
    expect(payload.containerId).toBe('abc123');
  });

  it('refuses to stop a deployment that is not running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    const res = await request(app).post(`/deployments/${created.body.id}/stop`);
    expect(res.status).toBe(409);
  });

  it('restarts a running deployment by emitting server.restart', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc123' });

    const res = await request(app).post(`/deployments/${created.body.id}/restart`);
    expect(res.status).toBe(202);

    const restart = published.find((p) => p.key === 'infra.server.restart');
    expect(restart).toBeDefined();
    const payload = readPayload(restart!.envelope.event) as Record<string, unknown>;
    expect(payload.containerId).toBe('abc123');
  });

  it('refuses to restart a deployment that is not running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    const res = await request(app).post(`/deployments/${created.body.id}/restart`);
    expect(res.status).toBe(409);
  });

  it('starts a stopped deployment by re-emitting server.start from its config', async () => {
    await seedHealthyNode(repo);
    const created = await request(app)
      .post('/deployments')
      .send({ name: 'svc', dockerImage: 'nginx', ports: { '8080': '80' } });
    await repo.updateDeploymentStatus(created.body.id, { status: 'stopped', containerId: null });
    published.length = 0; // ignore the events from creation

    const res = await request(app).post(`/deployments/${created.body.id}/start`);
    expect(res.status).toBe(202);

    const start = published.find((p) => p.key === 'infra.server.start');
    expect(start).toBeDefined();
    const payload = readPayload(start!.envelope.event) as Record<string, unknown>;
    expect(payload.deploymentId).toBe(created.body.id);
    expect(payload.dockerImage).toBe('nginx');
    expect(payload.ports).toEqual({ '8080': '80' });
  });

  it('refuses to start a deployment that is already running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc' });
    const res = await request(app).post(`/deployments/${created.body.id}/start`);
    expect(res.status).toBe(409);
  });

  it('gates log streaming on the deployment being running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

    // Not running yet → 409.
    expect((await request(app).get(`/deployments/${created.body.id}/logs`)).status).toBe(409);
    // Unknown deployment → 404.
    expect((await request(app).get('/deployments/nope/logs')).status).toBe(404);
  });

  it('gates stats streaming on the deployment being running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

    // Not running yet → 409.
    expect((await request(app).get(`/deployments/${created.body.id}/stats`)).status).toBe(409);
    // Unknown deployment → 404.
    expect((await request(app).get('/deployments/nope/stats')).status).toBe(404);
  });
});
