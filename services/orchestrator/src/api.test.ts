import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createApiRouter } from './api.js';

// API tests use a real Express app with the in-memory repo and a captured
// publisher, so no broker or database is needed. The key assertion is that
// creating a deployment emits infra.server.start for the chosen node.

// Quotas are the Billing Bridge's business and have their own tests below; every
// other suite stubs them out. Without this the default check makes a real HTTP
// call to an unreachable bridge whenever NEXUS_EDITION=hosted, so the suite sat
// waiting on DNS failures for a minute in the hosted CI leg (#173).
const allowQuota: Parameters<typeof createApiRouter>[0]['checkQuota'] = async () => ({ allowed: true, limit: Infinity });

function buildApp(repo: InMemoryRepository, published: Array<{ key: string; envelope: EventEnvelope }>) {
  const app = express();
  app.use(express.json());
  app.use(
    createApiRouter({
      repo,
      checkQuota: allowQuota,
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

    // The limits ride on server.start so the agent can enforce them (#107).
    const start = published.find((p) => p.key === 'infra.server.start');
    const payload = readPayload(start!.envelope.event) as Record<string, unknown>;
    expect(payload.resourceLimits).toEqual({ cpuPercent: 40, ramPercent: 60, restartPolicy: 'on-failure', oomKill: true });
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

  it('deletes a running deployment: stops it, then removes it', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc123' });

    const res = await request(app).delete(`/deployments/${created.body.id}`);
    expect(res.status).toBe(204);

    // It stopped the container first…
    const stop = published.find((p) => p.key === 'infra.server.stop');
    expect(stop).toBeDefined();
    // …and the deployment is gone.
    expect(await repo.getDeployment(created.body.id)).toBeNull();
    expect((await request(app).get('/deployments')).body).toHaveLength(0);
  });

  it('deletes a not-running deployment without a stop command', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

    const res = await request(app).delete(`/deployments/${created.body.id}`);
    expect(res.status).toBe(204);
    expect(published.some((p) => p.key === 'infra.server.stop')).toBe(false);
    expect(await repo.getDeployment(created.body.id)).toBeNull();
  });

  it('returns 404 deleting an unknown deployment', async () => {
    const res = await request(app).delete('/deployments/nope');
    expect(res.status).toBe(404);
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

  it('gates the console exec on the deployment being running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    expect((await request(app).post(`/deployments/${created.body.id}/exec`).send({ command: 'ls' })).status).toBe(409);
    expect((await request(app).post('/deployments/nope/exec').send({ command: 'ls' })).status).toBe(404);
  });

  it('gates file management on the deployment being running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

    // Not running yet → 409 (before any call reaches the node agent).
    expect((await request(app).get(`/deployments/${created.body.id}/files`)).status).toBe(409);
    expect((await request(app).delete(`/deployments/${created.body.id}/files`).query({ path: '/x' })).status).toBe(409);
    // Unknown deployment → 404.
    expect((await request(app).get('/deployments/nope/files')).status).toBe(404);
  });

  it('provisions, lists and deletes a managed database', async () => {
    // Wire a fake provisioner/deprovisioner so no node agent is needed.
    const provisioned: Array<{ engine: string; name: string }> = [];
    const deprovisioned: string[] = [];
    const dbApp = express();
    dbApp.use(express.json());
    dbApp.use(
      createApiRouter({
        repo,
        checkQuota: allowQuota,
        publish: async (key, envelope) => (published.push({ key, envelope }), true),
        provisionDatabase: async (req) => {
          provisioned.push({ engine: req.engine, name: req.name });
          return { containerId: 'db-c1', port: 33060 };
        },
        deprovisionDatabase: async (_agentUrl, id) => void deprovisioned.push(id),
      })
    );

    await seedHealthyNode(repo);
    const created = await request(dbApp).post('/deployments').send({ name: 'my-app', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc', nodeId: 'node-local' });

    const make = await request(dbApp).post(`/deployments/${created.body.id}/databases`).send({ engine: 'mysql' });
    expect(make.status).toBe(201);
    expect(make.body.engine).toBe('mysql');
    expect(make.body.name).toBe('my_app_db1');
    expect(make.body.host).toBe('localhost');
    expect(make.body.port).toBe(33060);
    expect(provisioned).toEqual([{ engine: 'mysql', name: 'my_app_db1' }]);

    const list = await request(dbApp).get(`/deployments/${created.body.id}/databases`);
    expect(list.body).toHaveLength(1);

    const del = await request(dbApp).delete(`/deployments/${created.body.id}/databases/${make.body.id}`);
    expect(del.status).toBe(204);
    expect(deprovisioned).toEqual(['db-c1']);
    expect((await request(dbApp).get(`/deployments/${created.body.id}/databases`)).body).toEqual([]);
  });

  it('rejects a database on a stopped deployment or with a bad engine', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    // Not running → 409.
    expect((await request(app).post(`/deployments/${created.body.id}/databases`).send({ engine: 'mysql' })).status).toBe(409);

    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc', nodeId: 'node-local' });
    // Running but unknown engine → 400.
    expect((await request(app).post(`/deployments/${created.body.id}/databases`).send({ engine: 'mongo' })).status).toBe(400);
  });

  it('creates, lists, restores and deletes a backup', async () => {
    const snapshots: string[] = [];
    const restores: string[] = [];
    const removes: string[] = [];
    const bkApp = express();
    bkApp.use(express.json());
    bkApp.use(
      createApiRouter({
        repo,
        checkQuota: allowQuota,
        publish: async (key, envelope) => (published.push({ key, envelope }), true),
        snapshotBackup: async (req) => (snapshots.push(req.containerId), { ref: 'bk_x', sizeBytes: 4096, path: '/data' }),
        restoreBackup: async (req) => void restores.push(req.ref),
        removeBackup: async (_agentUrl, ref) => void removes.push(ref),
      })
    );

    await seedHealthyNode(repo);
    const created = await request(bkApp).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc', nodeId: 'node-local' });

    const make = await request(bkApp).post(`/deployments/${created.body.id}/backups`).send({});
    expect(make.status).toBe(201);
    expect(make.body.sizeBytes).toBe(4096);
    expect(snapshots).toEqual(['abc']);

    expect((await request(bkApp).get(`/deployments/${created.body.id}/backups`)).body).toHaveLength(1);

    const rest = await request(bkApp).post(`/deployments/${created.body.id}/backups/${make.body.id}/restore`);
    expect(rest.status).toBe(200);
    expect(restores).toEqual(['bk_x']);

    const del = await request(bkApp).delete(`/deployments/${created.body.id}/backups/${make.body.id}`);
    expect(del.status).toBe(204);
    expect(removes).toEqual(['bk_x']);
    expect((await request(bkApp).get(`/deployments/${created.body.id}/backups`)).body).toEqual([]);
  });

  it('gates creating a backup on the deployment being running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    expect((await request(app).post(`/deployments/${created.body.id}/backups`).send({})).status).toBe(409);
    expect((await request(app).get('/deployments/nope/backups')).status).toBe(404);
  });

  it('registers a node with a name/location and deregisters it', async () => {
    const reg = await request(app).post('/nodes').send({ name: 'Home box', location: 'home-server' });
    expect(reg.status).toBe(201);
    expect(reg.body.name).toBe('Home box');
    expect(reg.body.location).toBe('home-server');
    expect(reg.body.health).toBe('offline'); // no heartbeat yet
    expect(reg.body.id).toMatch(/^node-/); // auto-generated id

    expect((await request(app).get('/nodes')).body).toHaveLength(1);
    expect((await request(app).delete(`/nodes/${reg.body.id}`)).status).toBe(204);
    expect((await request(app).get('/nodes')).body).toEqual([]);
  });

  it('refuses to deregister a node that still hosts a running deployment', async () => {
    await seedHealthyNode(repo, 'node-busy');
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc', nodeId: 'node-busy' });
    expect((await request(app).delete('/nodes/node-busy')).status).toBe(409);
  });

  it('invites, validates, re-roles and revokes a subuser', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    const base = `/deployments/${created.body.id}/subusers`;

    // Bad email / role rejected.
    expect((await request(app).post(base).send({ email: 'nope', role: 'viewer' })).status).toBe(400);
    expect((await request(app).post(base).send({ email: 'a@b.com', role: 'owner' })).status).toBe(400);

    const inv = await request(app).post(base).send({ email: 'A@B.com', role: 'viewer' });
    expect(inv.status).toBe(201);
    expect(inv.body.email).toBe('a@b.com'); // normalised

    const patched = await request(app).patch(`${base}/${inv.body.id}`).send({ role: 'admin' });
    expect(patched.body.role).toBe('admin');

    expect((await request(app).get(base)).body).toHaveLength(1);
    expect((await request(app).delete(`${base}/${inv.body.id}`)).status).toBe(204);
    expect((await request(app).get(base)).body).toEqual([]);
  });

  it('creates, validates, toggles, runs and deletes a schedule', async () => {
    const ran: string[] = [];
    const schedApp = express();
    schedApp.use(express.json());
    schedApp.use(
      createApiRouter({
        repo,
        checkQuota: allowQuota,
        publish: async (key, envelope) => (published.push({ key, envelope }), true),
        scheduleActions: { restart: async (id) => void ran.push(`restart:${id}`), backup: async (id) => void ran.push(`backup:${id}`) },
      })
    );

    await seedHealthyNode(repo);
    const created = await request(schedApp).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

    // Bad cron / action are rejected.
    expect((await request(schedApp).post(`/deployments/${created.body.id}/schedules`).send({ name: 'x', cron: 'nope', action: 'backup' })).status).toBe(400);
    expect((await request(schedApp).post(`/deployments/${created.body.id}/schedules`).send({ name: 'x', cron: '0 4 * * *', action: 'launch' })).status).toBe(400);

    const make = await request(schedApp).post(`/deployments/${created.body.id}/schedules`).send({ name: 'Nightly', cron: '0 4 * * *', action: 'backup' });
    expect(make.status).toBe(201);
    expect(make.body.enabled).toBe(true);

    // Toggle off via PATCH.
    const patched = await request(schedApp).patch(`/deployments/${created.body.id}/schedules/${make.body.id}`).send({ enabled: false });
    expect(patched.body.enabled).toBe(false);

    // Run now triggers the action.
    const run = await request(schedApp).post(`/deployments/${created.body.id}/schedules/${make.body.id}/run`);
    expect(run.status).toBe(200);
    expect(ran).toEqual([`backup:${created.body.id}`]);

    expect((await request(schedApp).get(`/deployments/${created.body.id}/schedules`)).body).toHaveLength(1);
    expect((await request(schedApp).delete(`/deployments/${created.body.id}/schedules/${make.body.id}`)).status).toBe(204);
    expect((await request(schedApp).get(`/deployments/${created.body.id}/schedules`)).body).toEqual([]);
  });
});

describe('plan quota enforcement (#148)', () => {
  // A denying checkQuota stands in for the Billing Bridge in the hosted edition.
  function buildApp(repo: InMemoryRepository, checkQuota: Parameters<typeof createApiRouter>[0]['checkQuota']) {
    const app = express();
    app.use(express.json());
    app.use(createApiRouter({ repo, publish: async () => true, checkQuota, provisionDatabase: async () => ({ containerId: 'db-c', port: 5432 }) }));
    return app;
  }

  async function seedNode(repo: InMemoryRepository) {
    await repo.upsertNode({ id: 'node-local', name: 'node-local', lastHeartbeat: new Date().toISOString(), cpuPercent: 5, ramUsedMb: 500, ramTotalMb: 8000 });
  }

  it('allows a deployment within the server quota', async () => {
    const repo = new InMemoryRepository();
    await seedNode(repo);
    const app = buildApp(repo, async () => ({ allowed: true, limit: 5 }));
    const res = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    expect(res.status).toBe(201);
  });

  it('rejects a deployment over the server quota with 409', async () => {
    const repo = new InMemoryRepository();
    await seedNode(repo);
    const app = buildApp(repo, async (_u, resource) => ({ allowed: resource !== 'servers', limit: 2 }));
    const res = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/server quota/);
  });

  it('rejects a database over the database quota with 409', async () => {
    const repo = new InMemoryRepository();
    await seedNode(repo);
    const app = buildApp(repo, async (_u, resource) => ({ allowed: resource !== 'databases', limit: 1 }));
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc123' });
    const res = await request(app).post(`/deployments/${created.body.id}/databases`).send({ engine: 'postgres' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/database quota/);
  });
});

describe('multi-node agent routing (#171)', () => {
  // Placement already spans nodes; these prove the follow-up agent calls reach the
  // node that actually hosts the deployment rather than one hardcoded agent.
  async function seedNode(repo: InMemoryRepository, id: string, agentUrl: string | null, cpu: number) {
    await repo.upsertNode({ id, name: id, agentUrl, lastHeartbeat: new Date().toISOString(), cpuPercent: cpu, ramUsedMb: 1000, ramTotalMb: 8000 });
  }

  function buildApp(repo: InMemoryRepository, calls: string[]) {
    const app = express();
    app.use(express.json());
    app.use(
      createApiRouter({
        repo,
        checkQuota: allowQuota,
        publish: async () => true,
        provisionDatabase: async (req) => (calls.push(req.agentUrl), { containerId: 'db-1', port: 5432 }),
        snapshotBackup: async (req) => (calls.push(req.agentUrl), { ref: 'bk', sizeBytes: 1, path: '/data' }),
      })
    );
    return app;
  }

  it("uses the owning node's agent URL, not another node's", async () => {
    const repo = new InMemoryRepository();
    const calls: string[] = [];
    // node-a is least loaded, so a fresh deployment would land there — but we pin
    // this one to node-b to prove routing follows the deployment, not placement.
    await seedNode(repo, 'node-a', 'http://agent-a:9100', 1);
    await seedNode(repo, 'node-b', 'http://agent-b:9100', 90);
    const app = buildApp(repo, calls);

    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'c1', nodeId: 'node-b' });

    await request(app).post(`/deployments/${created.body.id}/databases`).send({ engine: 'postgres' });
    await request(app).post(`/deployments/${created.body.id}/backups`).send({});

    expect(calls).toEqual(['http://agent-b:9100', 'http://agent-b:9100']);
  });

  it('falls back to the configured default when the node advertises no URL', async () => {
    const repo = new InMemoryRepository();
    const calls: string[] = [];
    await seedNode(repo, 'node-local', null, 5);
    const app = buildApp(repo, calls);

    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'c1', nodeId: 'node-local' });
    await request(app).post(`/deployments/${created.body.id}/backups`).send({});

    // The single-node default — unchanged behaviour for existing setups.
    expect(calls).toEqual(['http://node-agent:9100']);
  });

  it('registers a node with an explicit agent URL', async () => {
    const repo = new InMemoryRepository();
    const app = buildApp(repo, []);
    const res = await request(app).post('/nodes').send({ id: 'node-c', agentUrl: 'http://agent-c:9100' });
    expect(res.status).toBe(201);
    expect((await repo.listNodes()).find((n) => n.id === 'node-c')?.agentUrl).toBe('http://agent-c:9100');
  });
});
