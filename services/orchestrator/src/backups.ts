import { expiredBackups, withPlanCeiling } from './retention.js';
import { dataMountFor, persistPathsFor } from './startCommand.js';
import type { Repository, ServerBackupRecord, ServerConfigRecord } from './types.js';

// Taking a backup and letting old ones go (#232) — one implementation for the
// Backups tab, the schedule runner and the retention sweep. The API and the
// scheduler each had their own copy of "snapshot, then record", and the
// scheduler's never learned anything the API's did.

export interface Snapshot {
  ref: string;
  sizeBytes: number;
  path: string;
  offsite?: 'stored' | 'failed' | null;
  offsiteError?: string;
}

export interface BackupDeps {
  repo: Repository;
  snapshot(req: { agentUrl: string; containerId: string; path?: string }): Promise<Snapshot>;
  remove(agentUrl: string, ref: string): Promise<void>;
  agentUrlFor(nodeId: string | null): Promise<string>;
  /** The owner's plan ceiling on backups per server (#297); absent or null for none. */
  backupCeiling?(userId: string): Promise<number | null>;
}

/**
 * What to snapshot when nobody says (#324): the server's own data directory. It
 * was always `/data`, which is right for most eggs and wrong for nearly every
 * application — an nginx server has no `/data`, so its backup failed.
 */
export function defaultBackupPath(config: ServerConfigRecord): string {
  return dataMountFor(config)?.containerPath ?? persistPathsFor(config)[0] ?? '/data';
}

export type BackupOutcome = { ok: true; backup: ServerBackupRecord; expired: number } | { ok: false; status: number; error: string };

export async function takeBackup(deps: BackupDeps, deploymentId: string, opts: { path?: string; by: 'user' | 'schedule' }): Promise<BackupOutcome> {
  const { repo } = deps;
  const detail = await repo.getDeployment(deploymentId);
  if (!detail) return { ok: false, status: 404, error: 'deployment not found' };
  if (detail.status !== 'running' || !detail.containerId) return { ok: false, status: 409, error: 'deployment is not running' };
  const config = await repo.getDeploymentConfig(deploymentId);
  if (!config) return { ok: false, status: 404, error: 'server config not found' };

  let snap: Snapshot;
  try {
    snap = await deps.snapshot({
      agentUrl: await deps.agentUrlFor(detail.nodeId),
      containerId: detail.containerId,
      path: opts.path ?? defaultBackupPath(config),
    });
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : 'backup failed' };
  }

  const backup = await repo.createBackup({
    deploymentId,
    name: `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    path: snap.path,
    ref: snap.ref,
    sizeBytes: snap.sizeBytes,
    offsite: snap.offsite ?? null,
  });
  await repo.appendDeploymentEvent(
    deploymentId,
    opts.by === 'schedule' ? 'schedule-backup' : 'backup-created',
    `snapshot of ${snap.path} (${snap.sizeBytes} bytes)${
      snap.offsite === 'stored' ? ', copied off-site' : snap.offsite === 'failed' ? `, but NOT copied off-site: ${snap.offsiteError ?? 'upload failed'}` : ''
    }`,
  );

  // Retention runs after a new backup lands, never before: a snapshot that
  // failed must not have cost the server one of its old ones.
  const expired = await enforceRetention(deps, deploymentId, new Date());
  return { ok: true, backup, expired };
}

/** Delete the backups a server's policy no longer keeps. Returns how many went. */
export async function enforceRetention(deps: BackupDeps, deploymentId: string, now: Date): Promise<number> {
  const { repo } = deps;
  const config = await repo.getDeploymentConfig(deploymentId);
  if (!config) return 0;
  const ceiling = deps.backupCeiling ? await deps.backupCeiling(config.userId) : null;
  const own = config.backupRetention ?? {};
  const policy = withPlanCeiling(own, ceiling);
  const expired = expiredBackups(await repo.listBackups(deploymentId), policy, now);
  if (expired.length === 0) return 0;

  const detail = await repo.getDeployment(deploymentId);
  const agentUrl = await deps.agentUrlFor(detail?.nodeId ?? null);
  let removed = 0;
  for (const b of expired) {
    try {
      await deps.remove(agentUrl, b.ref);
    } catch {
      // Kept on record so the next sweep tries again, rather than forgetting a
      // file that is still filling the node's disk.
      continue;
    }
    await repo.deleteBackup(b.id);
    removed++;
  }
  if (removed) {
    // Say which rule it was: a backup removed by the plan, not by anything the
    // owner set, is exactly the deletion somebody will want explained.
    const byPlan = policy.keepLast !== own.keepLast;
    await repo.appendDeploymentEvent(
      deploymentId,
      'backups-expired',
      `retention removed ${removed} backup${removed === 1 ? '' : 's'}${byPlan ? ` (your plan keeps ${policy.keepLast} per server)` : ''}`
    );
  }
  return removed;
}

/** The periodic half: a `keepDays` policy expires backups with nobody creating new ones. */
export async function sweepRetention(deps: BackupDeps, now: Date): Promise<number> {
  let total = 0;
  // One plan lookup per owner per sweep, not one per server.
  const ceilings = new Map<string, Promise<number | null>>();
  const ceilingOf = deps.backupCeiling;
  const swept: BackupDeps = ceilingOf
    ? {
        ...deps,
        backupCeiling: (userId) => {
          if (!ceilings.has(userId)) ceilings.set(userId, ceilingOf(userId));
          return ceilings.get(userId)!;
        },
      }
    : deps;
  for (const d of await deps.repo.listDeployments()) {
    try {
      total += await enforceRetention(swept, d.id, now);
    } catch {
      // One server's failure must not stop the sweep for the rest.
    }
  }
  return total;
}
