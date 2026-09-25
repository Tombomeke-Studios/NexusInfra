import { nodeHealth } from './nodeRegistry.js';
import type { NodeRecord, Repository } from './types.js';
import { allocatePorts, checkPorts } from './portAllocation.js';

// Moving a server to another node (#234).
//
// A server's data is its volumes on one node (#324), so moving it means moving
// those, then its backups, then saying where it lives now. The order is the
// safety: nothing on the source is touched until the target holds everything
// and the record points at it. If any step before that fails, what was copied
// to the target is removed — only that — and the server stays where it was.

export interface MigrationTransport {
  listVolumes(agentUrl: string, deploymentId: string): Promise<{ path: string }[]>;
  /** Stream one volume from the source node's export into the target node's import. */
  copyVolume(fromUrl: string, toUrl: string, deploymentId: string, path: string, image: string): Promise<void>;
  removeVolume(agentUrl: string, deploymentId: string, path: string): Promise<void>;
  copyBackup(fromUrl: string, toUrl: string, ref: string): Promise<void>;
  /** Delete a backup file from one node only — never its off-site copy, which the target still uses. */
  removeBackupFile(agentUrl: string, ref: string): Promise<void>;
  /** Remove the server's containers and volumes from a node. */
  purge(agentUrl: string, deploymentId: string): Promise<void>;
}

export interface MigrationDeps {
  repo: Repository;
  transport: MigrationTransport;
  agentUrlFor(nodeId: string | null): Promise<string>;
}

/** Servers being moved right now. One orchestrator process owns a migration from start to end. */
const inFlight = new Set<string>();

export function isMigrating(deploymentId: string): boolean {
  return inFlight.has(deploymentId);
}

export type MigrationCheck = { ok: true; run: () => Promise<void> } | { ok: false; status: number; error: string };

/**
 * Validate a move and hand back the work, so the route can answer at once and
 * run it in the background: a large world takes longer than a proxy will hold a
 * request open.
 */
export async function planMigration(deps: MigrationDeps, deploymentId: string, targetNodeId: string, now = Date.now()): Promise<MigrationCheck> {
  const { repo } = deps;
  const detail = await repo.getDeployment(deploymentId);
  if (!detail) return { ok: false, status: 404, error: 'deployment not found' };
  if (inFlight.has(deploymentId)) return { ok: false, status: 409, error: 'this server is already being moved' };
  if (detail.status === 'running' || detail.status === 'pending') {
    return { ok: false, status: 409, error: 'stop the server first — a running server cannot be moved' };
  }
  const config = await repo.getDeploymentConfig(deploymentId);
  if (!config) return { ok: false, status: 404, error: 'server config not found' };
  if (config.dataPath) {
    return { ok: false, status: 409, error: `this server runs on an imported directory (${config.dataPath}) that exists only on its node, and cannot be moved` };
  }

  const nodes = await repo.listNodes();
  const target = nodes.find((n) => n.id === targetNodeId);
  if (!target) return { ok: false, status: 400, error: `unknown node ${targetNodeId}` };
  if (target.id === detail.nodeId) return { ok: false, status: 400, error: 'the server is already on that node' };
  if (nodeHealth(target, now) !== 'healthy') return { ok: false, status: 409, error: `node ${target.id} is not healthy` };
  if (target.maintenance) return { ok: false, status: 409, error: `node ${target.id} is in maintenance` };

  const source = detail.nodeId ? nodes.find((n) => n.id === detail.nodeId) : undefined;
  if (source && nodeHealth(source, now) === 'offline') {
    return { ok: false, status: 409, error: `node ${source.id} is offline, and the server's data is on it — it can be moved once that node is back` };
  }

  // Its ports have to be free there too (#233) — checked now, claimed at the switch.
  const ports = await checkPorts(repo, target, config.ports, deploymentId);
  if (!ports.ok) return { ok: false, status: 409, error: `cannot move to ${target.id}: ${ports.error}` };

  inFlight.add(deploymentId);
  const run = async () => {
    try {
      await migrate(deps, deploymentId, config.dockerImage, config.ports, source?.id ?? null, target);
    } finally {
      inFlight.delete(deploymentId);
    }
  };
  return { ok: true, run };
}

async function migrate(
  deps: MigrationDeps,
  deploymentId: string,
  image: string,
  ports: Record<string, string>,
  fromNode: string | null,
  target: NodeRecord,
): Promise<void> {
  const { repo, transport } = deps;
  const toNode = target.id;
  await repo.appendDeploymentEvent(deploymentId, 'migration-started', `moving from ${fromNode ?? 'no node'} to ${toNode}`);

  // Never placed: nothing to carry, only a record to change.
  if (!fromNode) {
    const claimed = await allocatePorts(repo, deploymentId, target, ports);
    if (!claimed.ok) {
      await repo.appendDeploymentEvent(deploymentId, 'migration-failed', `could not move to ${toNode}: ${claimed.error}`);
      return;
    }
    await repo.updateDeploymentStatus(deploymentId, { nodeId: toNode });
    await repo.appendDeploymentEvent(deploymentId, 'migrated', `assigned to ${toNode} (it held no data yet)`);
    return;
  }

  const fromUrl = await deps.agentUrlFor(fromNode);
  const toUrl = await deps.agentUrlFor(toNode);
  const imported: string[] = [];
  const copiedBackups: string[] = [];
  const backups = await repo.listBackups(deploymentId);

  try {
    for (const volume of await transport.listVolumes(fromUrl, deploymentId)) {
      await transport.copyVolume(fromUrl, toUrl, deploymentId, volume.path, image);
      imported.push(volume.path);
    }
    for (const backup of backups) {
      await transport.copyBackup(fromUrl, toUrl, backup.ref);
      copiedBackups.push(backup.ref);
    }
    // Claim its ports on the target last, so a failure above leaves them free.
    const claimed = await allocatePorts(repo, deploymentId, target, ports);
    if (!claimed.ok) throw new Error(claimed.error);
  } catch (err) {
    // Undo exactly what this migration created, and nothing else.
    for (const path of imported) await transport.removeVolume(toUrl, deploymentId, path).catch(() => undefined);
    for (const ref of copiedBackups) await transport.removeBackupFile(toUrl, ref).catch(() => undefined);
    await repo.appendDeploymentEvent(
      deploymentId,
      'migration-failed',
      `could not move to ${toNode}: ${err instanceof Error ? err.message : String(err)} — the server is still on ${fromNode}, unchanged`,
    );
    return;
  }

  // The switch. From here the target is where the server lives.
  await repo.updateDeploymentStatus(deploymentId, { nodeId: toNode });
  await repo.appendDeploymentEvent(
    deploymentId,
    'migrated',
    `moved from ${fromNode} to ${toNode}: ${imported.length} volume${imported.length === 1 ? '' : 's'}, ${copiedBackups.length} backup${copiedBackups.length === 1 ? '' : 's'}`,
  );

  // Clean the source. Best-effort: the move has happened, and leftovers are disk
  // space, not a second copy anyone will start from — start follows the record.
  const leftovers: string[] = [];
  await transport.purge(fromUrl, deploymentId).catch((err) => leftovers.push(`volumes (${err instanceof Error ? err.message : err})`));
  for (const ref of copiedBackups) {
    await transport.removeBackupFile(fromUrl, ref).catch(() => leftovers.push(`backup ${ref}`));
  }
  if (leftovers.length) {
    await repo.appendDeploymentEvent(deploymentId, 'migration-cleanup-incomplete', `left on ${fromNode}: ${leftovers.join(', ')}`);
  }
}
