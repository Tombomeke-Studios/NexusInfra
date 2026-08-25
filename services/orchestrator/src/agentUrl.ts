import type { NodeRecord } from './types.js';

// Resolving which Node Agent to talk to (#171).
//
// Placement is already multi-node: selectNode picks the least-loaded healthy node
// and start/stop/restart are addressed by nodeId over the bus. But every *direct*
// agent call (files, exec, terminal, logs/stats, backups, databases) used one
// hardcoded NODE_AGENT_URL, so a deployment on node-B had its file and exec calls
// sent to node-A — silently operating on the wrong host.
//
// Each node now carries its agent's reachable base URL (reported on its heartbeat,
// or set explicitly at registration). The env fallback keeps the single-node setup
// working unchanged when nodes report no URL.

/** Strip trailing slashes so callers can always append `/path`. */
export function normalizeAgentUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The base URL for a node's agent: the node's own `agentUrl` when known,
 * otherwise `fallback` (the single-node `NODE_AGENT_URL`).
 */
export function resolveAgentUrl(node: Pick<NodeRecord, 'agentUrl'> | null | undefined, fallback: string): string {
  const own = node?.agentUrl;
  if (typeof own === 'string' && own.trim().length > 0) return normalizeAgentUrl(own);
  return normalizeAgentUrl(fallback);
}
