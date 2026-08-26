import { describe, it, expect } from 'vitest';
import { reconcileNode, createReconcileHandler, type NodeInventory } from './reconcile.js';
import { buildEnvelope, readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import type { DeploymentStatus, DeploymentView } from './types.js';

// The outbox (#167) protects lifecycle reports from a broker outage. It does
// nothing for the agent process itself dying, after which the orchestrator's
// records describe a machine that no longer matches (#244).

function server(
  id: string,
  status: DeploymentStatus,
  containerId: string | null,
  extra: Partial<DeploymentView> & { autoRestart?: boolean } = {}
): DeploymentView {
  return {
    id,
    serverConfigId: `cfg-${id}`,
    nodeId: 'node-1',
    containerId,
    status,
    startedAt: null,
    stoppedAt: null,
    createdAt: new Date().toISOString(),
    name: id,
    dockerImage: 'nginx',
    userId: 'u1',
    teamId: null,
    type: 'generic',
    resourceLimits: {},
    ...extra,
  };
}

const inventory = (containers: NodeInventory['containers']): NodeInventory => ({ nodeId: 'node-1', containers });

describe('reconcileNode', () => {
  it('does nothing when the world matches the records', () => {
    const actions = reconcileNode([server('a', 'running', 'c1')], inventory([{ containerId: 'c1', running: true }]));
    expect(actions).toEqual([]);
  });

  it('marks a server stopped when its container is gone', () => {
    // A green light nobody investigates is worse than an honest red one.
    const actions = reconcileNode([server('a', 'running', 'c1')], inventory([]));
    expect(actions).toEqual([{ type: 'mark-stopped', deploymentId: 'a', reason: expect.stringContaining('node agent restarted') }]);
  });

  it('marks a server stopped when its container exists but is not running', () => {
    const actions = reconcileNode([server('a', 'running', 'c1')], inventory([{ containerId: 'c1', running: false }]));
    expect(actions[0].type).toBe('mark-stopped');
  });

  it('restarts a server that asked to be kept alive', () => {
    const actions = reconcileNode([server('a', 'running', 'c1', { autoRestart: true })], inventory([]));
    expect(actions).toEqual([{ type: 'restart', deploymentId: 'a', reason: expect.any(String) }]);
  });

  it('restarts a server whose restart policy is always', () => {
    const actions = reconcileNode(
      [server('a', 'running', 'c1', { resourceLimits: { restartPolicy: 'always' } })],
      inventory([])
    );
    expect(actions[0].type).toBe('restart');
  });

  it('does not restart a server that never asked to be', () => {
    // Guessing here starts containers nobody asked for.
    const actions = reconcileNode([server('a', 'running', 'c1', { autoRestart: false })], inventory([]));
    expect(actions[0].type).toBe('mark-stopped');
  });

  // 'pending' means we asked for a container and never heard back. After the
  // agent restarted, that request is gone and is not coming.
  it('resolves a pending server the node never confirmed', () => {
    const actions = reconcileNode([server('a', 'pending', null)], inventory([]));
    expect(actions).toEqual([{ type: 'mark-stopped', deploymentId: 'a', reason: expect.stringContaining("before this server was confirmed") }]);
  });

  it('adopts a container that is running although the record says stopped', () => {
    // Docker restarted it, or it was never really stopped. The container exists
    // either way, and insisting on the record does not make it go away.
    const actions = reconcileNode([server('a', 'stopped', 'c1')], inventory([{ containerId: 'c1', running: true }]));
    expect(actions).toEqual([
      { type: 'mark-running', deploymentId: 'a', containerId: 'c1', reason: expect.any(String) },
    ]);
  });

  it('leaves a stopped server alone when its container is really gone', () => {
    expect(reconcileNode([server('a', 'stopped', 'c1')], inventory([]))).toEqual([]);
  });

  // An inventory describes one machine. Treating its silence as evidence about
  // another node would wipe every other node's state on one agent restart.
  it('ignores deployments on other nodes', () => {
    const elsewhere = server('b', 'running', 'c9', { nodeId: 'node-2' });
    expect(reconcileNode([elsewhere], inventory([]))).toEqual([]);
  });

  it('handles a whole node coming back with nothing running', () => {
    const actions = reconcileNode(
      [
        server('a', 'running', 'c1', { autoRestart: true }),
        server('b', 'running', 'c2'),
        server('c', 'stopped', 'c3'),
        server('d', 'pending', null),
      ],
      inventory([])
    );

    expect(actions.map((a) => `${a.type}:${a.deploymentId}`)).toEqual([
      'restart:a',
      'mark-stopped:b',
      'mark-stopped:d',
    ]);
  });

  it('copes with a container the orchestrator has never heard of', () => {
    // Started by hand, or left over from a deployment that was deleted. Not this
    // function's business to remove — it only reconciles what it has records for.
    expect(reconcileNode([], inventory([{ containerId: 'stranger', running: true }]))).toEqual([]);
  });
});

// Turning those decisions into records and commands.
describe('createReconcileHandler', () => {
  function inventoryEvent(nodeId: string, containers: { containerId: string; running: boolean }[]): EventEnvelope {
    return buildEnvelope(`node-agent:${nodeId}`, { type: 'node.inventory', payload: { nodeId, containers } } as never);
  }

  async function setup() {
    const repo = new InMemoryRepository();
    const published: { key: string; envelope: EventEnvelope }[] = [];
    const handle = createReconcileHandler({
      repo,
      publish: async (key, envelope) => {
        published.push({ key, envelope });
        return true;
      },
    });
    await repo.upsertNode({ id: 'node-1', lastHeartbeat: new Date().toISOString() });
    return { repo, published, handle };
  }

  async function seedServer(repo: InMemoryRepository, autoRestart = false) {
    const config = await repo.createServerConfig({ userId: 'u1', name: 'svc', dockerImage: 'nginx', autoRestart });
    const deployment = await repo.createDeployment(config.id, 'node-1');
    await repo.updateDeploymentStatus(deployment.id, { status: 'running', containerId: 'c1' });
    return deployment.id;
  }

  it('records a server as stopped when the node no longer has its container', async () => {
    const { repo, handle } = await setup();
    const id = await seedServer(repo);

    await handle(inventoryEvent('node-1', []));

    const detail = await repo.getDeployment(id);
    expect(detail?.status).toBe('stopped');
    expect(detail?.containerId).toBeNull();
    // Written down, because a server that changes state unasked is exactly what
    // somebody will later want explained (#223).
    expect(detail?.events.map((e) => e.event)).toContain('reconciled-stopped');
  });

  it('restarts a server that asked to be kept alive, from its saved config', async () => {
    const { repo, published, handle } = await setup();
    const id = await seedServer(repo, true);

    await handle(inventoryEvent('node-1', []));

    const start = published.find((p) => p.key === 'infra.server.start');
    expect(start).toBeDefined();
    const payload = readPayload(start!.envelope.event) as Record<string, unknown>;
    expect(payload.deploymentId).toBe(id);
    expect(payload.dockerImage).toBe('nginx');
    expect((await repo.getDeployment(id))?.status).toBe('pending');
  });

  it('adopts a container that is running though the record said stopped', async () => {
    const { repo, handle } = await setup();
    const id = await seedServer(repo);
    await repo.updateDeploymentStatus(id, { status: 'stopped', containerId: 'c1' });

    await handle(inventoryEvent('node-1', [{ containerId: 'c1', running: true }]));

    expect((await repo.getDeployment(id))?.status).toBe('running');
  });

  it('leaves everything alone when the node matches the records', async () => {
    const { repo, published, handle } = await setup();
    const id = await seedServer(repo);

    await handle(inventoryEvent('node-1', [{ containerId: 'c1', running: true }]));

    expect((await repo.getDeployment(id))?.status).toBe('running');
    expect(published).toHaveLength(0);
  });

  it('ignores events that are not an inventory', async () => {
    const { repo, handle } = await setup();
    const id = await seedServer(repo);

    await handle(buildEnvelope('somebody', { type: 'server.stopped', payload: { deploymentId: id, containerId: 'c1' } }));
    expect((await repo.getDeployment(id))?.status).toBe('running');
  });

  it('does not touch servers on a node that did not report', async () => {
    // One agent restarting must not wipe every other node's state.
    const { repo, handle } = await setup();
    const id = await seedServer(repo);

    await handle(inventoryEvent('node-2', []));
    expect((await repo.getDeployment(id))?.status).toBe('running');
  });
});
