import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';

// Contract tests for the Repository boundary, run against the in-memory
// implementation. PrismaRepository (db.ts) implements the same interface and is
// exercised end-to-end via docker-compose in the verification steps.

describe('InMemoryRepository', () => {
  let repo: InMemoryRepository;

  beforeEach(() => {
    repo = new InMemoryRepository();
  });

  it('upserts a node, preserving prior fields when omitted', async () => {
    await repo.upsertNode({
      id: 'node-1',
      name: 'node-1',
      lastHeartbeat: '2026-07-21T00:00:00.000Z',
      cpuPercent: 20,
      ramUsedMb: 1024,
      ramTotalMb: 4096,
    });
    // A later heartbeat updates liveness but omits resources.
    const updated = await repo.upsertNode({ id: 'node-1', lastHeartbeat: '2026-07-21T00:00:01.000Z' });

    expect(updated.lastHeartbeat).toBe('2026-07-21T00:00:01.000Z');
    expect(updated.cpuPercent).toBe(20); // preserved
    expect(updated.ramTotalMb).toBe(4096);

    const nodes = await repo.listNodes();
    expect(nodes).toHaveLength(1);
  });

  it('creates a deployment joined to its config in listDeployments', async () => {
    const config = await repo.createServerConfig({
      userId: 'dev-user',
      name: 'my-nginx',
      dockerImage: 'nginx',
      ports: { '8080': '80' },
    });
    await repo.createDeployment(config.id, 'node-1');

    const list = await repo.listDeployments();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('my-nginx');
    expect(list[0].dockerImage).toBe('nginx');
    expect(list[0].nodeId).toBe('node-1');
    expect(list[0].status).toBe('pending');
  });

  it('persists the full server config and round-trips it via getDeploymentConfig', async () => {
    const config = await repo.createServerConfig({
      userId: 'dev-user',
      name: 'capped',
      dockerImage: 'nginx',
      env: { LOG_LEVEL: 'debug' },
      type: 'game',
      autoRestart: true,
      resourceLimits: { cpuPercent: 40, ramPercent: 60, restartPolicy: 'on-failure', oomKill: true },
    });
    const deployment = await repo.createDeployment(config.id, 'node-1');

    const saved = await repo.getDeploymentConfig(deployment.id);
    expect(saved?.type).toBe('game');
    expect(saved?.autoRestart).toBe(true);
    expect(saved?.env).toEqual({ LOG_LEVEL: 'debug' });
    expect(saved?.resourceLimits).toEqual({ cpuPercent: 40, ramPercent: 60, restartPolicy: 'on-failure', oomKill: true });
  });

  it('defaults resourceLimits to an empty object when omitted', async () => {
    const config = await repo.createServerConfig({ userId: 'u', name: 'svc', dockerImage: 'nginx' });
    expect(config.resourceLimits).toEqual({});
  });

  it('updates deployment status and records events on the detail view', async () => {
    const config = await repo.createServerConfig({ userId: 'u', name: 'svc', dockerImage: 'nginx' });
    const deployment = await repo.createDeployment(config.id, 'node-1');

    await repo.appendDeploymentEvent(deployment.id, 'created', 'deployment created');
    const running = await repo.updateDeploymentStatus(deployment.id, {
      status: 'running',
      containerId: 'abc123',
      startedAt: '2026-07-21T00:00:05.000Z',
    });
    await repo.appendDeploymentEvent(deployment.id, 'started', 'container abc123 started');

    expect(running?.status).toBe('running');
    expect(running?.containerId).toBe('abc123');

    const detail = await repo.getDeployment(deployment.id);
    expect(detail?.status).toBe('running');
    expect(detail?.events.map((e) => e.event)).toEqual(['created', 'started']);
  });

  it('returns null when updating a missing deployment', async () => {
    expect(await repo.updateDeploymentStatus('nope', { status: 'running' })).toBeNull();
    expect(await repo.getDeployment('nope')).toBeNull();
  });

  it('creates, lists and deletes managed databases per deployment', async () => {
    const db = await repo.createDatabase({
      deploymentId: 'dep-1',
      engine: 'mysql',
      name: 'app_db1',
      username: 'u_app',
      password: 'secret',
      host: 'localhost',
      port: 33060,
      containerId: 'db-c1',
    });
    // Scoped to the deployment; a different deployment sees none.
    expect(await repo.listDatabases('dep-1')).toHaveLength(1);
    expect(await repo.listDatabases('other')).toEqual([]);
    expect((await repo.getDatabase(db.id))?.name).toBe('app_db1');

    await repo.deleteDatabase(db.id);
    expect(await repo.getDatabase(db.id)).toBeNull();
    expect(await repo.listDatabases('dep-1')).toEqual([]);
  });
});
