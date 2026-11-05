import type { NodeRecord } from './types.js';
import { linkBaseUrl } from './agentLink.js';

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
 *
 * An outbound node (#416) has no address to call; its URL names the node's agent
 * link instead, and `agentFetch` sends the request over that link. Its
 * `agentUrl`, if any was ever stored, is ignored — a stale address would be the
 * wrong machine, or nothing.
 */
export function resolveAgentUrl(
  node: (Pick<NodeRecord, 'agentUrl'> & Partial<Pick<NodeRecord, 'id' | 'connection'>>) | null | undefined,
  fallback: string
): string {
  if (node?.connection === 'outbound' && node.id) return linkBaseUrl(node.id);
  const own = node?.agentUrl;
  if (typeof own === 'string' && own.trim().length > 0) return normalizeAgentUrl(own);
  return normalizeAgentUrl(fallback);
}
