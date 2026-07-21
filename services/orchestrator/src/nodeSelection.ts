import { nodeHealth } from './nodeRegistry.js';
import type { NodeRecord } from './types.js';

// Resource-aware node selection — the "least-loaded" placement algorithm.
// Only healthy nodes are eligible; among them the one with the lowest combined
// load (CPU fraction + RAM-used fraction) wins. Ties break on id for determinism.

/** Combined load score in [0, 2]; lower is less loaded. Unknown metrics count as 0.5. */
export function nodeLoad(node: NodeRecord): number {
  const cpuFraction = node.cpuPercent != null ? node.cpuPercent / 100 : 0.5;
  const ramFraction =
    node.ramTotalMb && node.ramUsedMb != null && node.ramTotalMb > 0 ? node.ramUsedMb / node.ramTotalMb : 0.5;
  return cpuFraction + ramFraction;
}

/**
 * Picks the least-loaded healthy node, or null when none are healthy.
 * `now` is injected so selection and tests share a single clock.
 */
export function selectNode(nodes: NodeRecord[], now: number = Date.now()): NodeRecord | null {
  const healthy = nodes.filter((n) => nodeHealth(n, now) === 'healthy');
  if (healthy.length === 0) return null;

  return healthy.reduce((best, candidate) => {
    const bestLoad = nodeLoad(best);
    const candidateLoad = nodeLoad(candidate);
    if (candidateLoad < bestLoad) return candidate;
    if (candidateLoad === bestLoad && candidate.id < best.id) return candidate;
    return best;
  });
}
