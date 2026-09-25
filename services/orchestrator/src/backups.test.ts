import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';
import { defaultBackupPath, enforceRetention, sweepRetention, takeBackup, type BackupDeps } from './backups.js';
import type { ServerConfigRecord } from './types.js';

describe('backups (#232)', () => {
  let repo: InMemoryRepository;
  let removed: string[];
  let snaps: Array<{ path?: string }>;
  let deps: BackupDeps;
  let id: string;
  let seq = 0;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    removed = [];
    snaps = [];
    deps = {
      repo,
      agentUrlFor: async () => 'http://agent',
      snapshot: async (req) => {
        snaps.push({ path: req.path });
        return { ref: `bk_${++seq}`, sizeBytes: 10, path: req.path ?? '/data', offsite: 'stored' };
      },
      remove: async (_url, ref) => void removed.push(ref),
    };
    const config = await repo.createServerConfig({ userId: 'u', name: 'web', dockerImage: 'nginx', type: 'app', persistPaths: ['/srv/www'] });
    id = (await repo.createDeployment(config.id, 'node-1')).id;
    await repo.updateDeploymentStatus(id, { status: 'running', containerId: 'c1' });
  });

  it("snapshots the server's own data directory by default, not a /data it may not have", async () => {
    const outcome = await takeBackup(deps, id, { by: 'user' });
    expect(outcome.ok).toBe(true);
    expect(snaps).toEqual([{ path: '/srv/www' }]);
  });

  it('records whether the copy left the node', async () => {
    const outcome = await takeBackup(deps, id, { by: 'user' });
    expect(outcome.ok && outcome.backup.offsite).toBe('stored');
    expect((await repo.getDeployment(id))?.events.at(-1)?.message).toContain('copied off-site');
  });

  it('says plainly when the off-site copy failed', async () => {
    deps.snapshot = async () => ({ ref: 'bk_x', sizeBytes: 1, path: '/srv/www', offsite: 'failed', offsiteError: 'off-site upload failed (403 AccessDenied)' });
    await takeBackup(deps, id, { by: 'schedule' });
    expect((await repo.getDeployment(id))?.events.at(-1)?.message).toContain('NOT copied off-site: off-site upload failed (403 AccessDenied)');
  });

  it('refuses a server that is not running and keeps every old backup', async () => {
    await repo.updateDeploymentConfig(id, { backupRetention: { keepLast: 1 } });
    await takeBackup(deps, id, { by: 'user' });
    await takeBackup(deps, id, { by: 'user' });
    await repo.updateDeploymentStatus(id, { status: 'stopped', containerId: null });

    const outcome = await takeBackup(deps, id, { by: 'user' });
    expect(outcome).toMatchObject({ ok: false, status: 409 });
    expect(await repo.listBackups(id)).toHaveLength(1);
  });

  it('applies the retention policy after each new backup', async () => {
    await repo.updateDeploymentConfig(id, { backupRetention: { keepLast: 2 } });
    for (let i = 0; i < 4; i++) {
      await takeBackup(deps, id, { by: 'user' });
      await new Promise((r) => setTimeout(r, 2));
    }
    // The two most recent snapshots survive; the first two went.
    const left = (await repo.listBackups(id)).map((b) => b.ref).sort();
    expect(left).toEqual([`bk_${seq - 1}`, `bk_${seq}`].sort());
    expect(removed.sort()).toEqual([`bk_${seq - 3}`, `bk_${seq - 2}`].sort());
  });

  it('keeps the record when the node refuses to delete the file, so the next sweep retries', async () => {
    await repo.updateDeploymentConfig(id, { backupRetention: { keepLast: 1 } });
    await takeBackup(deps, id, { by: 'user' });
    await new Promise((r) => setTimeout(r, 2));
    deps.remove = async () => {
      throw new Error('node down');
    };
    await takeBackup(deps, id, { by: 'user' });
    expect(await repo.listBackups(id)).toHaveLength(2);
  });

  it('expires by age with nobody taking backups — the sweep', async () => {
    const old = await repo.createBackup({ deploymentId: id, name: 'old', path: '/srv/www', ref: 'bk_old', sizeBytes: 1 });
    await repo.createBackup({ deploymentId: id, name: 'new', path: '/srv/www', ref: 'bk_new', sizeBytes: 1 });
    await repo.updateDeploymentConfig(id, { backupRetention: { keepDays: 7 } });
    // Make "old" old, and the other one the newest.
    (old as { createdAt: string }).createdAt = new Date(Date.now() - 30 * 86_400_000).toISOString();

    expect(await sweepRetention(deps, new Date())).toBe(1);
    expect(removed).toEqual(['bk_old']);
    expect(await enforceRetention(deps, id, new Date())).toBe(0);
  });
});

describe('defaultBackupPath', () => {
  const base = { id: 'c', userId: 'u', teamId: null, name: 'n', dockerImage: 'x', ports: {}, env: {}, resourceLimits: {}, autoRestart: false, dataPath: null, persistPaths: [], backupRetention: {}, type: 'app', createdAt: '' } as ServerConfigRecord;

  it("uses an egg's data directory", () => {
    expect(defaultBackupPath({ ...base, type: 'valheim' })).toBe('/config');
  });

  it('uses an imported directory where it is mounted', () => {
    expect(defaultBackupPath({ ...base, type: 'minecraft-java', dataPath: '/srv/import' })).toBe('/data');
  });

  it("falls back to /data only when nothing better is known", () => {
    expect(defaultBackupPath(base)).toBe('/data');
  });
});
