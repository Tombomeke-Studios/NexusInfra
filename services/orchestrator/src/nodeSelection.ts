import { nodeHealth } from './nodeRegistry.js';
import type { NodeRecord } from './types.js';

// Resource-aware node selection — the "least-loaded" placement algorithm.
// Only healthy nodes not in maintenance are eligible; among them the one with the
// lowest combined load (CPU fraction + RAM-used fraction) wins. Ties break on id
// for determinism.
//
// Maintenance is excluded here rather than at the call site because that is the
// whole point of draining a node: an emptied host is the *most* attractive
// candidate to a load-based scoring function, so anything that forgets to filter
// it sends every new server straight to the machine you are trying to empty (#258).

/** Combined load score in [0, 2]; lower is less loaded. Unknown metrics count as 0.5. */
export function nodeLoad(node: NodeRecord): number {
  const cpuFraction = node.cpuPercent != null ? node.cpuPercent / 100 : 0.5;
  const ramFraction =
    node.ramTotalMb && node.ramUsedMb != null && node.ramTotalMb > 0 ? node.ramUsedMb / node.ramTotalMb : 0.5;
  return cpuFraction + ramFraction;
}

/**
 * Picks the least-loaded healthy node that is not draining, or null when there is
 * none. `now` is injected so selection and tests share a single clock.
 */
export function selectNode(nodes: NodeRecord[], now: number = Date.now()): NodeRecord | null {
  const healthy = nodes.filter((n) => nodeHealth(n, now) === 'healthy' && !n.maintenance);
  if (healthy.length === 0) return null;

  return healthy.reduce((best, candidate) => {
    const bestLoad = nodeLoad(best);
    const candidateLoad = nodeLoad(candidate);
    if (candidateLoad < bestLoad) return candidate;
    if (candidateLoad === bestLoad && candidate.id < best.id) return candidate;
    return best;
  });
}
