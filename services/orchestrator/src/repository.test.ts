import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';
import { nodeHealth } from './nodeRegistry.js';

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

  it('registers a node, relabels it, and keeps location across liveness beats', async () => {
    const reg = await repo.registerNode({ id: 'node-1', name: 'Home box', location: 'home-server' });
    expect(reg.name).toBe('Home box');
    expect(reg.location).toBe('home-server');
    // Registered-but-unseen reads offline (epoch heartbeat).
    expect(nodeHealth(reg, Date.now())).toBe('offline');

    // A liveness/resource heartbeat must not wipe the name/location.
    await repo.upsertNode({ id: 'node-1', lastHeartbeat: new Date().toISOString(), cpuPercent: 20 });
    const seen = (await repo.listNodes())[0];
    expect(seen.name).toBe('Home box');
    expect(seen.location).toBe('home-server');
    expect(seen.cpuPercent).toBe(20);

    // Relabel just the location.
    const relabelled = await repo.registerNode({ id: 'node-1', location: 'office-rack' });
    expect(relabelled.location).toBe('office-rack');
    expect(relabelled.name).toBe('Home box'); // untouched
  });

  it('deletes a node and detaches it from its deployments', async () => {
    await repo.registerNode({ id: 'node-1' });
    const config = await repo.createServerConfig({ userId: 'u', name: 'svc', dockerImage: 'nginx' });
    const dep = await repo.createDeployment(config.id, 'node-1');

    await repo.deleteNode('node-1');
    expect(await repo.listNodes()).toEqual([]);
    // The deployment survives but is detached from the removed node.
    expect((await repo.getDeployment(dep.id))?.nodeId).toBeNull();
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

  // The detail view is what the server-detail page renders. Without the runtime
  // configuration on it, the Network and Startup tabs had nothing real to show
  // and rendered invented values instead (#217, #218).
  it('carries the runtime configuration on the detail view', async () => {
    const config = await repo.createServerConfig({
      userId: 'dev-user',
      name: 'web',
      dockerImage: 'nginx:alpine',
      ports: { '8080': '80' },
      env: { LOG_LEVEL: 'debug' },
      autoRestart: true,
      resourceLimits: { cpuPercent: 40, ramPercent: 60 },
    });
    const deployment = await repo.createDeployment(config.id, 'node-1');

    const detail = await repo.getDeployment(deployment.id);
    expect(detail?.ports).toEqual({ '8080': '80' });
    expect(detail?.env).toEqual({ LOG_LEVEL: 'debug' });
    expect(detail?.resourceLimits).toEqual({ cpuPercent: 40, ramPercent: 60 });
    expect(detail?.autoRestart).toBe(true);
  });

  it('defaults the detail view configuration to empty rather than omitting it', async () => {
    const config = await repo.createServerConfig({ userId: 'u', name: 'svc', dockerImage: 'nginx' });
    const deployment = await repo.createDeployment(config.id, 'node-1');

    const detail = await repo.getDeployment(deployment.id);
    expect(detail?.ports).toEqual({});
    expect(detail?.env).toEqual({});
    expect(detail?.autoRestart).toBe(false);
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

  it('deletes a deployment and all of its child records', async () => {
    const config = await repo.createServerConfig({ userId: 'u', name: 'svc', dockerImage: 'nginx' });
    const deployment = await repo.createDeployment(config.id, 'node-1');
    await repo.appendDeploymentEvent(deployment.id, 'created', 'deployment created');
    await repo.createDatabase({ deploymentId: deployment.id, engine: 'postgres', name: 'db', username: 'u', password: 'p', host: 'h', port: 5432, containerId: 'c' });
    await repo.createBackup({ deploymentId: deployment.id, name: 'b', path: '/data', ref: 'r', sizeBytes: 1 });
    await repo.createSchedule({ deploymentId: deployment.id, name: 's', cron: '0 0 * * *', action: 'backup', enabled: true });
    await repo.createSubuser({ deploymentId: deployment.id, email: 'a@b.com', role: 'viewer' });

    await repo.deleteDeployment(deployment.id);

    expect(await repo.getDeployment(deployment.id)).toBeNull();
    expect(await repo.getDeploymentConfig(deployment.id)).toBeNull();
    expect(await repo.listDatabases(deployment.id)).toHaveLength(0);
    expect(await repo.listBackups(deployment.id)).toHaveLength(0);
    expect(await repo.listSchedules(deployment.id)).toHaveLength(0);
    expect(await repo.listSubusers(deployment.id)).toHaveLength(0);
    expect(await repo.listDeployments()).toHaveLength(0);
  });

  it('deleteDeployment on a missing id is a no-op', async () => {
    await expect(repo.deleteDeployment('nope')).resolves.toBeUndefined();
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

  it('creates, lists and deletes backups per deployment', async () => {
    const b = await repo.createBackup({ deploymentId: 'dep-1', name: 'backup-1', path: '/data', ref: 'bk_1', sizeBytes: 2048 });
    expect(b.status).toBe('ready');
    expect(await repo.listBackups('dep-1')).toHaveLength(1);
    expect(await repo.listBackups('other')).toEqual([]);
    expect((await repo.getBackup(b.id))?.ref).toBe('bk_1');

    await repo.deleteBackup(b.id);
    expect(await repo.getBackup(b.id)).toBeNull();
  });

  it('invites, re-invites (relabels role), lists and revokes subusers', async () => {
    const su = await repo.createSubuser({ deploymentId: 'dep-1', email: 'a@b.com', role: 'viewer' });
    expect(su.role).toBe('viewer');
    // Re-inviting the same email updates the role rather than duplicating.
    const again = await repo.createSubuser({ deploymentId: 'dep-1', email: 'a@b.com', role: 'admin' });
    expect(again.id).toBe(su.id);
    expect((await repo.listSubusers('dep-1'))).toHaveLength(1);
    expect((await repo.listSubusers('dep-1'))[0].role).toBe('admin');

    const promoted = await repo.updateSubuserRole(su.id, 'viewer');
    expect(promoted?.role).toBe('viewer');

    await repo.deleteSubuser(su.id);
    expect(await repo.getSubuser(su.id)).toBeNull();
  });

  it('creates, updates, lists and deletes schedules', async () => {
    const s = await repo.createSchedule({ deploymentId: 'dep-1', name: 'Nightly', cron: '0 4 * * *', action: 'backup' });
    expect(s.enabled).toBe(true);
    expect(s.lastRunAt).toBeNull();

    const off = await repo.updateSchedule(s.id, { enabled: false, lastRunAt: '2026-07-24T04:00:00.000Z' });
    expect(off?.enabled).toBe(false);
    expect(off?.lastRunAt).toBe('2026-07-24T04:00:00.000Z');
    expect(off?.name).toBe('Nightly'); // untouched fields preserved

    expect(await repo.listSchedules('dep-1')).toHaveLength(1);
    expect(await repo.listAllSchedules()).toHaveLength(1);

    await repo.deleteSchedule(s.id);
    expect(await repo.getSchedule(s.id)).toBeNull();
  });
});
