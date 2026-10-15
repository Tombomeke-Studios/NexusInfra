import type { ResourceLimits } from 'shared';
import type { DeploymentView, NodeRecord } from './types.js';

// What a node has, what it has already promised, and what is left (#275).
//
// Three different numbers get confused with each other constantly, so they are
// named separately here:
//
// - **total** — the hardware. Fixed.
// - **committed** — the sum of the caps handed to the servers placed on this
//   node. What the node has promised.
// - **used** — what is being consumed right now.
//
// "How much can I still give a new server" is answered by *committed*, and the
// New Deployment form used to answer it with *used*. That is wrong twice over.
// Four servers capped at a quarter of the RAM each leave nothing to give away,
// but if they are idle the live figure looks almost empty. And Linux spends spare
// memory on page cache, so a node running nothing at all can report most of its
// RAM "used" and look full.
//
// Pure: nodes and deployments in, numbers out.

export interface NodeCapacity {
  ramTotalMb: number | null;
  ramCommittedMb: number;
  ramUsedMb: number | null;
  cpuCoresTotal: number | null;
  cpuCoresCommitted: number;
  cpuUsedPercent: number | null;
}

/** The memory a single server has been promised, in MB, or 0 when it has no cap. */
export function committedRamMb(limits: ResourceLimits | undefined, nodeTotalMb: number | null | undefined): number {
  if (!limits) return 0;
  if (limits.ramMb && limits.ramMb > 0) return Math.round(limits.ramMb);
  if (limits.ramPercent && limits.ramPercent > 0 && nodeTotalMb && nodeTotalMb > 0) {
    return Math.round((limits.ramPercent / 100) * nodeTotalMb);
  }
  // An uncapped server is not free — it can take the whole node — but there is no
  // honest number to add here, so it counts as zero and the panel says elsewhere
  // that uncapped servers exist. Inventing a figure is what #250 was about.
  return 0;
}

/** The CPU a single server has been promised, in cores, or 0 when it has no cap. */
export function committedCpuCores(limits: ResourceLimits | undefined, nodeCores: number | null | undefined): number {
  if (!limits) return 0;
  if (limits.cpuCores && limits.cpuCores > 0) return limits.cpuCores;
  if (limits.cpuPercent && limits.cpuPercent > 0 && nodeCores && nodeCores > 0) {
    return (limits.cpuPercent / 100) * nodeCores;
  }
  return 0;
}

/** Round to two decimals — cores are fractional and 1.7000000000000002 helps nobody. */
const cores = (n: number) => Math.round(n * 100) / 100;

/**
 * A node's totals, what it has committed to the servers placed on it, and its
 * live usage.
 *
 * Only deployments that still exist count: a stopped server keeps its cap, since
 * starting it again must not need capacity that has been given away in the
 * meantime.
 */
export function nodeCapacity(node: NodeRecord, deployments: DeploymentView[]): NodeCapacity {
  const here = deployments.filter((d) => d.nodeId === node.id);

  return {
    ramTotalMb: node.ramTotalMb ?? null,
    ramCommittedMb: here.reduce((sum, d) => sum + committedRamMb(d.resourceLimits, node.ramTotalMb), 0),
    ramUsedMb: node.ramUsedMb ?? null,
    cpuCoresTotal: node.cpuCores ?? null,
    cpuCoresCommitted: cores(here.reduce((sum, d) => sum + committedCpuCores(d.resourceLimits, node.cpuCores), 0)),
    cpuUsedPercent: node.cpuPercent ?? null,
  };
}

/**
 * What is left to hand out, or null when the node has not reported its hardware.
 *
 * Never negative: a node can be over-committed (nothing stops you promising more
 * than exists), and "-2048 MB free" is a worse answer than "none".
 */
export function availableRamMb(capacity: NodeCapacity): number | null {
  if (capacity.ramTotalMb == null) return null;
  return Math.max(0, capacity.ramTotalMb - capacity.ramCommittedMb);
}

export function availableCpuCores(capacity: NodeCapacity): number | null {
  if (capacity.cpuCoresTotal == null) return null;
  return cores(Math.max(0, capacity.cpuCoresTotal - capacity.cpuCoresCommitted));
}

/** Whether the node has promised more than it has — possible, and worth saying. */
export function isOverCommitted(capacity: NodeCapacity): boolean {
  const ramOver = capacity.ramTotalMb != null && capacity.ramCommittedMb > capacity.ramTotalMb;
  const cpuOver = capacity.cpuCoresTotal != null && capacity.cpuCoresCommitted > capacity.cpuCoresTotal;
  return ramOver || cpuOver;
}
