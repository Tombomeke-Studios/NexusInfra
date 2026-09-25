import { PortConflictError, planPorts, rangeOf, type TakenPorts } from './portPool.js';
import type { NodeRecord, Repository } from './types.js';

// The repository side of host ports (#233): what a node's servers hold, and
// taking a set for one server. Pure decisions live in portPool.ts.

export async function takenPorts(repo: Repository, nodeId: string): Promise<TakenPorts> {
  const names = new Map((await repo.listDeployments()).map((d) => [d.id, d.name]));
  const taken: TakenPorts = new Map();
  for (const a of await repo.listPortAllocations({ nodeId })) {
    taken.set(a.port, { deploymentId: a.deploymentId, name: names.get(a.deploymentId) ?? 'another server' });
  }
  return taken;
}

export type Allocation = { ok: true; ports: Record<string, string>; hostPorts: number[] } | { ok: false; status: 400 | 409; error: string };

/** Plan a server's ports on a node without writing anything — for a check before other work. */
export async function checkPorts(repo: Repository, node: NodeRecord, ports: Record<string, string>, self?: string): Promise<Allocation> {
  return planPorts({ ports, range: rangeOf(node), taken: await takenPorts(repo, node.id), self });
}

/**
 * Plan and write a server's ports on a node. The write can still lose a race to
 * another request that planned the same port a moment earlier; the unique
 * constraint catches that, and it is reported like any other conflict.
 */
export async function allocatePorts(repo: Repository, deploymentId: string, node: NodeRecord, ports: Record<string, string>): Promise<Allocation> {
  const plan = await checkPorts(repo, node, ports, deploymentId);
  if (!plan.ok) return plan;
  try {
    await repo.replacePortAllocations(deploymentId, node.id, plan.hostPorts);
  } catch (err) {
    if (err instanceof PortConflictError) return { ok: false, status: 409, error: `port ${err.port} was just taken by another server on this node` };
    throw err;
  }
  return plan;
}

/**
 * Record the ports servers from before #233 already hold, so the check knows
 * about them. Idempotent; a pair of old servers that already clash keeps its
 * first claimant, and the second is left for its owner to fix.
 */
export async function backfillPortAllocations(repo: Repository): Promise<number> {
  let added = 0;
  for (const d of await repo.listDeployments()) {
    if (!d.nodeId) continue;
    if ((await repo.listPortAllocations({ deploymentId: d.id })).length) continue;
    const config = await repo.getDeploymentConfig(d.id);
    const ports = Object.keys(config?.ports ?? {}).map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
    if (!ports.length) continue;
    const taken = await takenPorts(repo, d.nodeId);
    const free = ports.filter((p) => !taken.has(p));
    if (!free.length) continue;
    await repo.replacePortAllocations(d.id, d.nodeId, free).catch(() => undefined);
    added += free.length;
  }
  return added;
}
