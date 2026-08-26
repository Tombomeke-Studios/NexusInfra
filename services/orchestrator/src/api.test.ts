import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createApiRouter } from './api.js';
import { createUserService } from './users.js';

// API tests use a real Express app with the in-memory repo and a captured
// publisher, so no broker or database is needed. The key assertion is that
// creating a deployment emits infra.server.start for the chosen node.

// Quotas are the Billing Bridge's business and have their own tests below; every
// other suite stubs them out. Without this the default check makes a real HTTP
// call to an unreachable bridge whenever NEXUS_EDITION=hosted, so the suite sat
// waiting on DNS failures for a minute in the hosted CI leg (#173).
const allowQuota: Parameters<typeof createApiRouter>[0]['checkQuota'] = async () => ({ allowed: true, limit: Infinity });

// Every route is now behind authentication and per-server authorization (#175),
// so these suites run as a real account. `asPrincipal` stands in for requireAuth,
// which has its own tests in auth.test.ts.
export const OWNER = { id: 'user-owner', email: 'owner@example.com', platformRole: 'user' as const };
const PLATFORM_ADMIN = { id: 'user-root', email: 'root@example.com', platformRole: 'admin' as const };

function asPrincipal(principal: { id: string; platformRole: 'owner' | 'admin' | 'user' } = OWNER): express.RequestHandler {
  return (req, _res, next) => {
    (req as express.Request & { principal?: unknown; userId?: string }).principal = principal;
    (req as express.Request & { userId?: string }).userId = principal.id;
    next();
  };
}

/** Give the acting account a record, so shares can be matched to its address. */
async function seedUser(repo: InMemoryRepository, user = OWNER) {
  await repo.createUser({ id: user.id, email: user.email, displayName: user.id, passwordHash: '!', platformRole: user.platformRole });
}

function buildApp(
  repo: InMemoryRepository,
  published: Array<{ key: string; envelope: EventEnvelope }>,
  principal: { id: string; platformRole: 'owner' | 'admin' | 'user' } = OWNER
) {
  const app = express();
  app.use(express.json());

  app.use(asPrincipal(principal));
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

  beforeEach(async () => {
    repo = new InMemoryRepository();
    published = [];
    app = buildApp(repo, published);
    await seedUser(repo);
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

  // The panel's Placement control let you pin a server to a node, and the choice
  // was never sent — the orchestrator always picked the least-loaded node (#254).
  describe('placement', () => {
    it('honours a pinned node instead of picking one', async () => {
      await seedHealthyNode(repo, 'node-busy');
      await seedHealthyNode(repo, 'node-idle');
      // Make node-busy the loaded one, so least-loaded would never choose it.
      await repo.upsertNode({ id: 'node-busy', lastHeartbeat: new Date().toISOString(), cpuPercent: 90, ramUsedMb: 7000, ramTotalMb: 8000 });

      const res = await request(app).post('/deployments').send({ name: 'pinned', dockerImage: 'nginx', nodeId: 'node-busy' });
      expect(res.status).toBe(201);
      expect(res.body.nodeId).toBe('node-busy');

      const start = published.find((p) => p.key === 'infra.server.start');
      expect((readPayload(start!.envelope.event) as Record<string, unknown>).nodeId).toBe('node-busy');
    });

    it('still picks the least-loaded node when none is pinned', async () => {
      await seedHealthyNode(repo, 'node-idle');
      const res = await request(app).post('/deployments').send({ name: 'auto', dockerImage: 'nginx' });
      expect(res.status).toBe(201);
      expect(res.body.nodeId).toBe('node-idle');
    });

    it('refuses an unknown pinned node rather than silently placing it elsewhere', async () => {
      await seedHealthyNode(repo, 'node-idle');
      const res = await request(app).post('/deployments').send({ name: 'pinned', dockerImage: 'nginx', nodeId: 'node-ghost' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/node/i);
      // Nothing was created or commanded.
      expect(await repo.listDeployments()).toHaveLength(0);
      expect(published.some((p) => p.key === 'infra.server.start')).toBe(false);
    });

    it('refuses a pinned node that is not healthy', async () => {
      await seedHealthyNode(repo, 'node-idle');
      // Registered but never seen — reads offline.
      await repo.registerNode({ id: 'node-down' });

      const res = await request(app).post('/deployments').send({ name: 'pinned', dockerImage: 'nginx', nodeId: 'node-down' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not healthy|offline/i);
    });
  });

  // Maintenance used to live in a browser tab: the panel relabelled the node and
  // the orchestrator kept scheduling onto it (#258).
  describe('node maintenance', () => {
    // Draining the fleet is an administrator's job, like registering a node.
    let adminApp: express.Express;
    beforeEach(() => {
      adminApp = buildApp(repo, published, PLATFORM_ADMIN);
    });

    it('is refused to a caller who is not a platform administrator', async () => {
      await seedHealthyNode(repo, 'node-drain');
      expect((await request(app).patch('/nodes/node-drain/maintenance').send({ maintenance: true })).status).toBe(403);
    });

    it('drains a node so nothing new is placed on it', async () => {
      await seedHealthyNode(repo, 'node-drain');

      const patch = await request(adminApp).patch('/nodes/node-drain/maintenance').send({ maintenance: true });
      expect(patch.status).toBe(200);
      expect(patch.body.maintenance).toBe(true);

      // It is the only node, and it is draining — nothing can be placed.
      const res = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
      expect(res.status).toBe(503);
    });

    it('refuses to pin a server to a draining node', async () => {
      await seedHealthyNode(repo, 'node-drain');
      await seedHealthyNode(repo, 'node-free');
      await request(adminApp).patch('/nodes/node-drain/maintenance').send({ maintenance: true });

      const res = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx', nodeId: 'node-drain' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/maintenance/i);
    });

    it('survives the heartbeats that keep arriving while the node drains', async () => {
      await seedHealthyNode(repo, 'node-drain');
      await request(adminApp).patch('/nodes/node-drain/maintenance').send({ maintenance: true });

      // The agent keeps beating every second; none of that is an instruction to
      // put the node back in the pool.
      await repo.upsertNode({ id: 'node-drain', lastHeartbeat: new Date().toISOString(), cpuPercent: 5 });

      const nodes = await request(app).get('/nodes');
      expect(nodes.body.find((n: { id: string }) => n.id === 'node-drain').maintenance).toBe(true);
      expect((await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' })).status).toBe(503);
    });

    it('puts the node back in the pool when maintenance is lifted', async () => {
      await seedHealthyNode(repo, 'node-drain');
      await request(adminApp).patch('/nodes/node-drain/maintenance').send({ maintenance: true });
      await request(adminApp).patch('/nodes/node-drain/maintenance').send({ maintenance: false });

      const res = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
      expect(res.status).toBe(201);
      expect(res.body.nodeId).toBe('node-drain');
    });

    it('404s an unknown node', async () => {
      expect((await request(adminApp).patch('/nodes/nope/maintenance').send({ maintenance: true })).status).toBe(404);
    });
  });

  // Every lifecycle change writes a DeploymentEvent and nothing ever read them
  // back — the trail was write-only, useless exactly when you need it (#223).
  describe('audit trail', () => {
    it('returns the trail newest first', async () => {
      await seedHealthyNode(repo);
      const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
      await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc' });
      await request(app).post(`/deployments/${created.body.id}/stop`);

      const res = await request(app).get(`/deployments/${created.body.id}/events`);
      expect(res.status).toBe(200);
      // 'created' happened first, so newest-first puts 'stop-requested' on top.
      expect(res.body[0].event).toBe('stop-requested');
      expect(res.body.map((e: { event: string }) => e.event)).toContain('created');
      expect(res.body[0]).toHaveProperty('timestamp');
      expect(res.body[0]).toHaveProperty('message');
    });

    it('paginates so a long-lived server does not return everything', async () => {
      await seedHealthyNode(repo);
      const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
      for (let i = 0; i < 10; i++) await repo.appendDeploymentEvent(created.body.id, `e${i}`, `event ${i}`);

      const res = await request(app).get(`/deployments/${created.body.id}/events`).query({ limit: 4 });
      expect(res.body).toHaveLength(4);
      expect(res.body[0].event).toBe('e9');

      const next = await request(app).get(`/deployments/${created.body.id}/events`).query({ limit: 4, offset: 4 });
      expect(next.body[0].event).toBe('e5');
    });

    it('is refused to someone with no access, as a 404', async () => {
      await seedHealthyNode(repo);
      const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });

      const stranger = buildApp(repo, published, { id: 'user-nobody', platformRole: 'user' });
      await repo.createUser({ id: 'user-nobody', email: 'nobody@example.com', displayName: 'n', passwordHash: '!', platformRole: 'user' });
      expect((await request(stranger).get(`/deployments/${created.body.id}/events`)).status).toBe(404);
    });
  });

  // A server's configuration was frozen at creation: fixing a typo in a name, or
  // adding an environment variable, meant deleting the server and losing its
  // databases, backups, schedules and subusers with it (#220).
  describe('editing a server', () => {
    async function makeServer() {
      await seedHealthyNode(repo);
      const created = await request(app)
        .post('/deployments')
        .send({ name: 'svc', dockerImage: 'nginx', ports: { '8080': '80' }, env: { A: '1' } });
      return created.body.id as string;
    }

    it('updates the stored configuration', async () => {
      const id = await makeServer();
      const res = await request(app).patch(`/deployments/${id}`).send({
        name: 'renamed',
        dockerImage: 'nginx:alpine',
        ports: { '9090': '80' },
        env: { A: '2', B: 'new' },
        autoRestart: true,
        resourceLimits: { cpuPercent: 25 },
      });

      expect(res.status).toBe(200);
      const config = await repo.getDeploymentConfig(id);
      expect(config?.name).toBe('renamed');
      expect(config?.dockerImage).toBe('nginx:alpine');
      expect(config?.ports).toEqual({ '9090': '80' });
      expect(config?.env).toEqual({ A: '2', B: 'new' });
      expect(config?.autoRestart).toBe(true);
      expect(config?.resourceLimits).toEqual({ cpuPercent: 25 });
    });

    it('leaves omitted fields alone', async () => {
      const id = await makeServer();
      await request(app).patch(`/deployments/${id}`).send({ name: 'renamed' });

      const config = await repo.getDeploymentConfig(id);
      expect(config?.name).toBe('renamed');
      expect(config?.dockerImage).toBe('nginx'); // untouched
      expect(config?.ports).toEqual({ '8080': '80' });
    });

    it('records the change in the audit trail', async () => {
      const id = await makeServer();
      await request(app).patch(`/deployments/${id}`).send({ name: 'renamed' });

      const detail = await repo.getDeployment(id);
      expect(detail?.events.map((e) => e.event)).toContain('config-updated');
    });

    // Changing config does not touch the running container: the panel says the
    // change lands on the next start, and the API must not quietly restart it.
    it('does not restart the server', async () => {
      const id = await makeServer();
      await repo.updateDeploymentStatus(id, { status: 'running', containerId: 'abc' });
      published.length = 0;

      await request(app).patch(`/deployments/${id}`).send({ dockerImage: 'nginx:alpine' });
      expect(published.some((p) => p.key.startsWith('infra.server.'))).toBe(false);
    });

    it('rejects an empty name or image', async () => {
      const id = await makeServer();
      expect((await request(app).patch(`/deployments/${id}`).send({ name: '   ' })).status).toBe(400);
      expect((await request(app).patch(`/deployments/${id}`).send({ dockerImage: '' })).status).toBe(400);
    });

    it('is refused to an operator, who may run the server but not redefine it', async () => {
      const id = await makeServer();
      await repo.createUser({ id: 'user-op', email: 'op@example.com', displayName: 'op', passwordHash: '!', platformRole: 'user' });
      await repo.createSubuser({ deploymentId: id, email: 'op@example.com', role: 'operator', userId: 'user-op', status: 'active' });

      const opApp = buildApp(repo, published, { id: 'user-op', platformRole: 'user' });
      expect((await request(opApp).patch(`/deployments/${id}`).send({ name: 'theirs' })).status).toBe(403);
    });
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

  // Kill exists for the container that ignores a graceful stop (#253). It is a
  // distinct command and a distinct audit entry, not a louder stop.
  it('kills a running deployment by emitting server.kill', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    await repo.updateDeploymentStatus(created.body.id, { status: 'running', containerId: 'abc123' });

    const res = await request(app).post(`/deployments/${created.body.id}/kill`);
    expect(res.status).toBe(202);

    const kill = published.find((p) => p.key === 'infra.server.kill');
    expect(kill).toBeDefined();
    const payload = readPayload(kill!.envelope.event) as Record<string, unknown>;
    expect(payload.containerId).toBe('abc123');

    // The trail must distinguish a kill from a stop, or "who killed it" is unanswerable.
    const detail = await repo.getDeployment(created.body.id);
    expect(detail?.events.map((e) => e.event)).toContain('kill-requested');
    expect(detail?.events.map((e) => e.event)).not.toContain('stop-requested');
  });

  it('refuses to kill a deployment that is not running', async () => {
    await seedHealthyNode(repo);
    const created = await request(app).post('/deployments').send({ name: 'svc', dockerImage: 'nginx' });
    const res = await request(app).post(`/deployments/${created.body.id}/kill`);
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

    dbApp.use(asPrincipal());
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

    bkApp.use(asPrincipal());
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
    // Managing the fleet is installation administration, not a tenant action.
    const app = buildApp(repo, published, PLATFORM_ADMIN);
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
    expect((await request(buildApp(repo, published, PLATFORM_ADMIN)).delete('/nodes/node-busy')).status).toBe(409);
  });

  it('refuses node registration and deregistration to an ordinary user', async () => {
    expect((await request(app).post('/nodes').send({ name: 'Sneaky box' })).status).toBe(403);
    await seedHealthyNode(repo, 'node-x');
    expect((await request(app).delete('/nodes/node-x')).status).toBe(403);
    expect(await repo.listNodes()).toHaveLength(1);
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

    schedApp.use(asPrincipal());
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

    app.use(asPrincipal());
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

  function buildApp(
    repo: InMemoryRepository,
    calls: string[],
    principal: { id: string; platformRole: 'owner' | 'admin' | 'user' } = OWNER
  ) {
    const app = express();
    app.use(express.json());

    app.use(asPrincipal(principal));
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
    const app = buildApp(repo, [], PLATFORM_ADMIN);
    const res = await request(app).post('/nodes').send({ id: 'node-c', agentUrl: 'http://agent-c:9100' });
    expect(res.status).toBe(201);
    expect((await repo.listNodes()).find((n) => n.id === 'node-c')?.agentUrl).toBe('http://agent-c:9100');
  });
});

// ── Per-server authorization (#175) ──────────────────────────────────────────
// The point of the whole sharing feature: someone else can run your server
// without being able to read its files, take its backups, or hand out access.
describe('per-server authorization', () => {
  const GUEST = { id: 'user-guest', email: 'guest@example.com', platformRole: 'user' as const };

  let repo: InMemoryRepository;
  let ownerApp: express.Express;
  let guestApp: express.Express;
  let deploymentId: string;

  /** Share the server with the guest at `role`, or revoke by passing null. */
  async function shareAs(role: string | null) {
    const existing = await repo.getSubuserFor(deploymentId, GUEST.email);
    if (existing) await repo.deleteSubuser(existing.id);
    // Bound and active, as inviting an address that already has an account
    // produces (#176). The pending case has its own tests below.
    if (role) await repo.createSubuser({ deploymentId, email: GUEST.email, role, userId: GUEST.id, status: 'active' });
  }

  beforeEach(async () => {
    repo = new InMemoryRepository();
    ownerApp = buildApp(repo, []);
    guestApp = buildApp(repo, [], GUEST);
    await seedUser(repo);
    await seedUser(repo, GUEST);
    await seedHealthyNode(repo);

    const created = await request(ownerApp).post('/deployments').send({ name: 'shared-svc', dockerImage: 'nginx' });
    deploymentId = created.body.id;
    await repo.updateDeploymentStatus(deploymentId, { status: 'running', containerId: 'c1', nodeId: 'node-local' });
  });

  describe('someone with no access at all', () => {
    it('cannot see the server in their list', async () => {
      expect((await request(guestApp).get('/deployments')).body).toEqual([]);
    });

    it('gets 404 rather than 403, so ids cannot be probed for existence', async () => {
      // 403 would confirm the server exists and belongs to someone else.
      expect((await request(guestApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/stop`)).status).toBe(404);
      expect((await request(guestApp).delete(`/deployments/${deploymentId}`)).status).toBe(404);
    });

    it('cannot reach a server it was never shared, even by exact id', async () => {
      await request(guestApp).get(`/deployments/${deploymentId}/files?path=/`).expect(404);
      await request(guestApp).post(`/deployments/${deploymentId}/exec`).send({ command: 'id' }).expect(404);
    });
  });

  describe('a viewer', () => {
    beforeEach(() => shareAs('viewer'));

    it('sees the server, with their role attached', async () => {
      const list = await request(guestApp).get('/deployments');
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ id: deploymentId, role: 'viewer' });
    });

    it('cannot start, stop or restart it', async () => {
      expect((await request(guestApp).post(`/deployments/${deploymentId}/stop`)).status).toBe(403);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/restart`)).status).toBe(403);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/start`)).status).toBe(403);
    });

    it('cannot read files or run commands', async () => {
      expect((await request(guestApp).get(`/deployments/${deploymentId}/files?path=/`)).status).toBe(403);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/exec`).send({ command: 'id' })).status).toBe(403);
    });
  });

  describe('an operator', () => {
    beforeEach(() => shareAs('operator'));

    it('can start, stop and restart the server — the reason the role exists', async () => {
      expect((await request(guestApp).post(`/deployments/${deploymentId}/stop`)).status).toBe(202);
      await repo.updateDeploymentStatus(deploymentId, { status: 'stopped', containerId: null });
      expect((await request(guestApp).post(`/deployments/${deploymentId}/start`)).status).toBe(202);
    });

    it('cannot write files, manage backups, databases or schedules', async () => {
      expect((await request(guestApp).put(`/deployments/${deploymentId}/files/content`).send({ path: '/x', content: 'y' })).status).toBe(403);
      expect((await request(guestApp).get(`/deployments/${deploymentId}/backups`)).status).toBe(403);
      expect((await request(guestApp).get(`/deployments/${deploymentId}/databases`)).status).toBe(403);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/schedules`).send({ name: 's', cron: '* * * * *', action: 'restart' })).status).toBe(403);
    });

    it('cannot see or change who else has access', async () => {
      expect((await request(guestApp).get(`/deployments/${deploymentId}/subusers`)).status).toBe(403);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/subusers`).send({ email: 'friend@example.com', role: 'admin' })).status).toBe(403);
    });

    it('cannot delete the server', async () => {
      expect((await request(guestApp).delete(`/deployments/${deploymentId}`)).status).toBe(403);
      expect(await repo.getDeployment(deploymentId)).not.toBeNull();
    });
  });

  describe('a server admin', () => {
    beforeEach(() => shareAs('admin'));

    it('can manage the server, but still cannot delete it', async () => {
      expect((await request(guestApp).get(`/deployments/${deploymentId}/subusers`)).status).toBe(200);
      expect((await request(guestApp).get(`/deployments/${deploymentId}/backups`)).status).toBe(200);
      expect((await request(guestApp).delete(`/deployments/${deploymentId}`)).status).toBe(403);
    });

    it('cannot escalate their own grant to owner', async () => {
      const res = await request(guestApp)
        .post(`/deployments/${deploymentId}/subusers`)
        .send({ email: GUEST.email, role: 'owner' });
      expect(res.status).toBe(400);
    });
  });

  describe('revoking a share', () => {
    it('takes the server away again immediately', async () => {
      await shareAs('operator');
      expect((await request(guestApp).get(`/deployments/${deploymentId}`)).status).toBe(200);

      await shareAs(null);
      expect((await request(guestApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
      expect((await request(guestApp).get('/deployments')).body).toEqual([]);
      expect((await request(guestApp).post(`/deployments/${deploymentId}/stop`)).status).toBe(404);
    });
  });

  describe('the owner', () => {
    it('keeps full control including deletion', async () => {
      const list = await request(ownerApp).get('/deployments');
      expect(list.body[0]).toMatchObject({ role: 'owner' });
      expect((await request(ownerApp).get(`/deployments/${deploymentId}/subusers`)).status).toBe(200);
      expect((await request(ownerApp).delete(`/deployments/${deploymentId}`)).status).toBe(204);
    });
  });

  describe('a platform administrator', () => {
    it('sees and controls every server without needing a share', async () => {
      const adminApp = buildApp(repo, [], PLATFORM_ADMIN);
      const list = await request(adminApp).get('/deployments');
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ role: 'owner' });
      expect((await request(adminApp).get(`/deployments/${deploymentId}`)).status).toBe(200);
    });
  });
});

// ── Invitations bound to accounts (#176) ─────────────────────────────────────
// You should be able to share a server with someone who has not signed up yet —
// without that invitation granting anything to whoever holds the address in the
// meantime.
describe('server invitations', () => {
  const NEWCOMER = { id: 'user-newcomer', email: 'newcomer@example.com', platformRole: 'user' as const };

  let repo: InMemoryRepository;
  let users: ReturnType<typeof createUserService>;
  let ownerApp: express.Express;
  let deploymentId: string;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    ownerApp = buildApp(repo, []);
    await seedUser(repo);
    await seedHealthyNode(repo);
    const created = await request(ownerApp).post('/deployments').send({ name: 'shared-svc', dockerImage: 'nginx' });
    deploymentId = created.body.id;
  });

  const invite = (email: string, role = 'operator') =>
    request(ownerApp).post(`/deployments/${deploymentId}/subusers`).send({ email, role });

  it('binds and activates immediately when the address already has an account', async () => {
    await seedUser(repo, NEWCOMER);
    const res = await invite(NEWCOMER.email);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'active', userId: NEWCOMER.id });
  });

  it('waits as a pending invitation when nobody holds the address yet', async () => {
    const res = await invite('stranger@example.com');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', userId: null });
  });

  it('grants nothing while pending', async () => {
    await invite(NEWCOMER.email);
    // The account is created *after* the invitation and has not signed in, so the
    // grant is still unbound; it must not open the server.
    await repo.createUser({ id: NEWCOMER.id, email: NEWCOMER.email, displayName: 'n', passwordHash: '!', platformRole: 'user' });

    const guestApp = buildApp(repo, [], NEWCOMER);
    expect((await request(guestApp).get(`/deployments/${deploymentId}`)).status).toBe(404);
    expect((await request(guestApp).get('/deployments')).body).toEqual([]);
  });

  it('is claimed when the invited person registers', async () => {
    await invite(NEWCOMER.email);
    const registered = await users.register({ email: NEWCOMER.email, password: 'newcomer1' });
    if (!registered.ok) throw new Error('expected registration to succeed');

    const guestApp = buildApp(repo, [], { id: registered.user.id, platformRole: 'user' });
    const list = await request(guestApp).get('/deployments');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: deploymentId, role: 'operator' });
  });

  it('is claimed when an existing account signs in for the first time after being invited', async () => {
    const created = await users.register({ email: NEWCOMER.email, password: 'newcomer1' });
    if (!created.ok) throw new Error('expected registration to succeed');
    // Force the pending state an out-of-band invitation would leave behind.
    const share = await repo.getSubuserFor(deploymentId, NEWCOMER.email);
    if (share) await repo.deleteSubuser(share.id);
    await repo.createSubuser({ deploymentId, email: NEWCOMER.email, role: 'viewer' });

    await users.authenticate(NEWCOMER.email, 'newcomer1');

    expect(await repo.getSubuserFor(deploymentId, NEWCOMER.email)).toMatchObject({ status: 'active', userId: created.user.id });
  });

  it('refuses to let the owner invite themselves', async () => {
    const res = await invite(OWNER.email);
    expect(res.status).toBe(400);
  });

  it('changes the role on re-invite without unbinding an accepted share', async () => {
    await seedUser(repo, NEWCOMER);
    await invite(NEWCOMER.email, 'viewer');
    const again = await invite(NEWCOMER.email, 'admin');
    expect(again.body).toMatchObject({ role: 'admin', status: 'active', userId: NEWCOMER.id });
  });
});
