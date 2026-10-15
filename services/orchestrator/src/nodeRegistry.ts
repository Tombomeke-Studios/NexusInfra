import { readPayload, type EventEnvelope } from 'shared';
import type { NodeHealth, NodeRecord, Repository } from './types.js';

// Node registry — keeps the `nodes` table current from the node heartbeat stream
// (monitoring.heartbeat.node.#). Every heartbeat refreshes lastHeartbeat; the ones
// that carry a resource snapshot (every 5s) also update CPU/RAM/disk.

// Health thresholds match Control Room (services/control-room/src/index.ts) so both
// derive the same status from a node's last-seen time.
export const DEGRADED_MS = 3000;
export const OFFLINE_MS = 10000;

/** Derives a node's health from how long ago its last heartbeat arrived. */
export function nodeHealth(node: NodeRecord, now: number): NodeHealth {
  const age = now - new Date(node.lastHeartbeat).getTime();
  if (age >= OFFLINE_MS) return 'offline';
  if (age >= DEGRADED_MS) return 'degraded';
  return 'healthy';
}

interface NodeHeartbeatPayload {
  nodeId?: string;
  timestamp?: string;
  /** Where this node's agent API is reachable, so calls route to the owning node (#171). */
  agentUrl?: string;
  resources?: {
    cpuPercent?: number;
    cpuCores?: number;
    ramUsedMb?: number;
    ramTotalMb?: number;
    diskUsedGb?: number;
    diskTotalGb?: number;
  };
}

export interface NodeRegistry {
  handleHeartbeat(envelope: EventEnvelope): Promise<void>;
}

/**
 * Creates a node registry backed by `repo`. `handleHeartbeat` decodes a
 * heartbeat.node event (transparently decrypting the payload) and upserts the
 * node. Resource fields are only forwarded when the pulse carries them, so
 * liveness-only beats never wipe the last known capacity.
 */
export function createNodeRegistry(repo: Repository): NodeRegistry {
  async function handleHeartbeat(envelope: EventEnvelope): Promise<void> {
    if (envelope.event.type !== 'heartbeat.node') return;
    const payload = readPayload(envelope.event) as NodeHeartbeatPayload;
    const nodeId = payload.nodeId;
    if (!nodeId) return;

    const r = payload.resources;
    // Don't send name/location: a heartbeat only refreshes liveness/resources, so a
    // node registered with a custom name or location (#113) keeps it. On first sight
    // the create path defaults the name to the id.
    await repo.upsertNode({
      id: nodeId,
      lastHeartbeat: payload.timestamp ?? new Date().toISOString(),
      // Only forwarded when advertised, so a node registered with an explicit URL
      // isn't cleared by an older agent that doesn't report one.
      agentUrl: payload.agentUrl,
      cpuPercent: r?.cpuPercent,
      cpuCores: r?.cpuCores,
      ramUsedMb: r?.ramUsedMb,
      ramTotalMb: r?.ramTotalMb,
      diskUsedGb: r?.diskUsedGb,
      diskTotalGb: r?.diskTotalGb,
    });
  }

  return { handleHeartbeat };
}
