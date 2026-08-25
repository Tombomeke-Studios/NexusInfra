import { describe, it, expect, beforeEach } from 'vitest';
import { buildEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createNodeRegistry, nodeHealth } from './nodeRegistry.js';
import type { NodeRecord } from './types.js';

function nodeHeartbeat(nodeId: string, timestamp: string, resources?: Record<string, number>) {
  return buildEnvelope(`node-agent:${nodeId}`, {
    type: 'heartbeat.node',
    payload: { nodeId, status: 'healthy', timestamp, resources } as never,
  });
}

describe('createNodeRegistry', () => {
  let repo: InMemoryRepository;
  let registry: ReturnType<typeof createNodeRegistry>;

  beforeEach(() => {
    repo = new InMemoryRepository();
    registry = createNodeRegistry(repo);
  });

  it('registers a node from a heartbeat carrying resources', async () => {
    await registry.handleHeartbeat(
      nodeHeartbeat('node-local', '2026-07-21T00:00:00.000Z', {
        cpuPercent: 30,
        ramUsedMb: 2048,
        ramTotalMb: 8192,
        diskUsedGb: 40,
        diskTotalGb: 200,
      })
    );

    const nodes = await repo.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('node-local');
    expect(nodes[0].cpuPercent).toBe(30);
    expect(nodes[0].ramTotalMb).toBe(8192);
  });

  it('preserves prior resources on a liveness-only heartbeat', async () => {
    await registry.handleHeartbeat(
      nodeHeartbeat('node-local', '2026-07-21T00:00:00.000Z', { cpuPercent: 55, ramUsedMb: 1000, ramTotalMb: 4000 })
    );
    // Liveness-only pulse: no resources block.
    await registry.handleHeartbeat(nodeHeartbeat('node-local', '2026-07-21T00:00:01.000Z'));

    const [node] = await repo.listNodes();
    expect(node.lastHeartbeat).toBe('2026-07-21T00:00:01.000Z');
    expect(node.cpuPercent).toBe(55); // preserved
    expect(node.ramTotalMb).toBe(4000);
  });

  it('does not clobber a registered node name/location on heartbeat (#113)', async () => {
    await repo.registerNode({ id: 'node-local', name: 'Home box', location: 'home-server' });
    await registry.handleHeartbeat(nodeHeartbeat('node-local', '2026-07-21T00:00:00.000Z', { cpuPercent: 12 }));

    const [node] = await repo.listNodes();
    expect(node.name).toBe('Home box'); // not overwritten with the id
    expect(node.location).toBe('home-server');
    expect(node.cpuPercent).toBe(12);
  });

  it('ignores non-node-heartbeat events', async () => {
    const service = buildEnvelope('control-room', {
      type: 'heartbeat.service',
      payload: { name: 'control-room', status: 'healthy', timestamp: '2026-07-21T00:00:00.000Z' },
    });
    await registry.handleHeartbeat(service);
    expect(await repo.listNodes()).toHaveLength(0);
  });
});

describe('nodeHealth', () => {
  const base: NodeRecord = {
    id: 'n',
    name: 'n',
    location: null,
    ipAddress: null,
    lastHeartbeat: '2026-07-21T00:00:00.000Z',
    cpuPercent: null,
    ramUsedMb: null,
    ramTotalMb: null,
    diskUsedGb: null,
    diskTotalGb: null,
  };
  const t0 = new Date('2026-07-21T00:00:00.000Z').getTime();

  it('is healthy under 3s', () => {
    expect(nodeHealth(base, t0 + 1000)).toBe('healthy');
  });
  it('is degraded between 3s and 10s', () => {
    expect(nodeHealth(base, t0 + 4000)).toBe('degraded');
  });
  it('is offline at/after 10s', () => {
    expect(nodeHealth(base, t0 + 10000)).toBe('offline');
  });
});
