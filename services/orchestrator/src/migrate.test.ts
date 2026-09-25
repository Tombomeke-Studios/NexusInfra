import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';
import { isMigrating, planMigration, type MigrationDeps, type MigrationTransport } from './migrate.js';

const healthy = (id: string) => ({ id, name: id, lastHeartbeat: new Date().toISOString(), cpuPercent: 5, ramUsedMb: 100, ramTotalMb: 8000 });

describe('moving a server between nodes (#234)', () => {
  let repo: InMemoryRepository;
  let log: string[];
  let transport: MigrationTransport;
  let deps: MigrationDeps;
  let id: string;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    log = [];
    transport = {
      listVolumes: async () => [{ path: '/data' }, { path: '/config' }],
      copyVolume: async (from, to, _d, path) => void log.push(`copy ${path} ${from}->${to}`),
      removeVolume: async (url, _d, path) => void log.push(`rm-vol ${path} @${url}`),
      copyBackup: async (from, to, ref) => void log.push(`copy-bk ${ref} ${from}->${to}`),
      removeBackupFile: async (url, ref) => void log.push(`rm-bk ${ref} @${url}`),
      purge: async (url) => void log.push(`purge @${url}`),
    };
    deps = { repo, transport, agentUrlFor: async (nodeId) => `http://${nodeId}` };
    await repo.upsertNode(healthy('node-a'));
    await repo.upsertNode(healthy('node-b'));
    const config = await repo.createServerConfig({ userId: 'u', name: 'world', dockerImage: 'itzg/minecraft-server', type: 'minecraft-java' });
    id = (await repo.createDeployment(config.id, 'node-a')).id;
    await repo.updateDeploymentStatus(id, { status: 'stopped' });
    await repo.createBackup({ deploymentId: id, name: 'b', path: '/data', ref: 'bk_1', sizeBytes: 1 });
  });

  async function move(to = 'node-b') {
    const plan = await planMigration(deps, id, to);
    if (!plan.ok) throw new Error(plan.error);
    await plan.run();
  }

  it('copies every volume and backup, switches the node, then cleans the source — in that order', async () => {
    await move();

    expect(log).toEqual([
      'copy /data http://node-a->http://node-b',
      'copy /config http://node-a->http://node-b',
      'copy-bk bk_1 http://node-a->http://node-b',
      'purge @http://node-a',
      'rm-bk bk_1 @http://node-a',
    ]);
    const detail = await repo.getDeployment(id);
    expect(detail?.nodeId).toBe('node-b');
    expect(detail?.events.find((e) => e.event === 'migrated')?.message).toBe('moved from node-a to node-b: 2 volumes, 1 backup');
  });

  it('on a failure, removes only what it copied and leaves the server where it was', async () => {
    transport.copyVolume = async (_f, _t, _d, path) => {
      if (path === '/config') throw new Error('disk full');
      log.push(`copy ${path}`);
    };
    await move();

    expect(log).toEqual(['copy /data', 'rm-vol /data @http://node-b']);
    const detail = await repo.getDeployment(id);
    expect(detail?.nodeId).toBe('node-a');
    expect(detail?.events.at(-1)).toMatchObject({ event: 'migration-failed', message: expect.stringContaining('disk full') });
    // The source was never touched.
    expect(log.some((l) => l.includes('node-a') && (l.startsWith('purge') || l.startsWith('rm-')))).toBe(false);
  });

  it('records what the source clean-up could not remove, without undoing the move', async () => {
    transport.purge = async () => {
      throw new Error('node-a went away');
    };
    await move();
    const detail = await repo.getDeployment(id);
    expect(detail?.nodeId).toBe('node-b');
    expect(detail?.events.at(-1)).toMatchObject({ event: 'migration-cleanup-incomplete', message: expect.stringContaining('node-a went away') });
  });

  it('holds a lock while it runs, and releases it', async () => {
    const plan = await planMigration(deps, id, 'node-b');
    expect(plan.ok && isMigrating(id)).toBe(true);
    expect(await planMigration(deps, id, 'node-b')).toMatchObject({ ok: false, status: 409 });
    if (plan.ok) await plan.run();
    expect(isMigrating(id)).toBe(false);
  });

  it('refuses a running server, an imported one, a bad target and the same node', async () => {
    await repo.updateDeploymentStatus(id, { status: 'running', containerId: 'c1' });
    expect(await planMigration(deps, id, 'node-b')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/stop the server/) });
    await repo.updateDeploymentStatus(id, { status: 'stopped', containerId: null });

    expect(await planMigration(deps, id, 'node-zzz')).toMatchObject({ ok: false, status: 400 });
    expect(await planMigration(deps, id, 'node-a')).toMatchObject({ ok: false, status: 400 });

    await repo.registerNode({ id: 'node-b', maintenance: true });
    expect(await planMigration(deps, id, 'node-b')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/maintenance/) });

    const imported = await repo.createServerConfig({ userId: 'u', name: 'imp', dockerImage: 'x', type: 'minecraft-java', dataPath: '/srv/world' });
    const impId = (await repo.createDeployment(imported.id, 'node-a')).id;
    await repo.updateDeploymentStatus(impId, { status: 'stopped' });
    expect(await planMigration(deps, impId, 'node-c')).toMatchObject({ ok: false });
    await repo.upsertNode(healthy('node-c'));
    expect(await planMigration(deps, impId, 'node-c')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/imported directory/) });
  });

  it('refuses while the source node is offline — the data cannot be read from it', async () => {
    await repo.upsertNode({ id: 'node-a', lastHeartbeat: new Date(Date.now() - 60_000).toISOString() });
    expect(await planMigration(deps, id, 'node-b')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/node-a is offline/) });
  });
});
