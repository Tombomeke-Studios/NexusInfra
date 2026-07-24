import { describe, it, expect, beforeEach } from 'vitest';
import { buildEnvelope, type EventEnvelope, type NexusInfraEvent } from 'shared';
import { createAgent } from './agent.js';
import type { ContainerRuntime, NodeResources, StartSpec } from './runtime.js';

// Fake runtime records calls and lets each test script success/failure.
class FakeRuntime implements ContainerRuntime {
  calls: string[] = [];
  nextContainerId = 'container-xyz';
  failOn: string | null = null;

  lastStartSpec: StartSpec | null = null;
  async start(spec: StartSpec): Promise<string> {
    this.calls.push(`start:${spec.dockerImage}`);
    this.lastStartSpec = spec;
    if (this.failOn === 'start') throw new Error('image pull failed');
    return this.nextContainerId;
  }
  async stop(containerId: string): Promise<void> {
    this.calls.push(`stop:${containerId}`);
    if (this.failOn === 'stop') throw new Error('no such container');
  }
  async restart(containerId: string): Promise<void> {
    this.calls.push(`restart:${containerId}`);
    if (this.failOn === 'restart') throw new Error('restart failed');
  }
  async collectResources(): Promise<NodeResources> {
    return { cpuPercent: 0, ramUsedMb: 0, ramTotalMb: 0, diskUsedGb: 0, diskTotalGb: 0 };
  }
  logs(): () => void {
    return () => {};
  }
  stats(): () => void {
    return () => {};
  }
}

const NODE_ID = 'node-1';

function makeAgent() {
  const runtime = new FakeRuntime();
  const published: Array<{ key: string; envelope: EventEnvelope }> = [];
  const agent = createAgent({
    nodeId: NODE_ID,
    runtime,
    publish: async (key, envelope) => {
      published.push({ key, envelope });
      return true;
    },
  });
  return { runtime, published, agent };
}

// Build a command envelope the way the Orchestrator would (no message key set,
// so payloads stay plaintext for these tests).
function cmd(event: NexusInfraEvent): EventEnvelope {
  return buildEnvelope('orchestrator', event);
}

describe('Node Agent command handling', () => {
  beforeEach(() => {
    delete process.env.FINVAULT_MESSAGE_KEY;
  });

  it('starts a container and reports server.started with the container id', async () => {
    const { runtime, published, agent } = makeAgent();
    await agent.handleCommand(
      cmd({ type: 'server.start', payload: { deploymentId: 'd-1', nodeId: NODE_ID, dockerImage: 'nginx:alpine' } })
    );

    expect(runtime.calls).toEqual(['start:nginx:alpine']);
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe('infra.server.started');
    expect(published[0].envelope.event.type).toBe('server.started');
    expect((published[0].envelope.event.payload as any).containerId).toBe('container-xyz');
    expect((published[0].envelope.event.payload as any).nodeId).toBe(NODE_ID);
  });

  it('forwards the resource limits from the command to the runtime start spec (#107)', async () => {
    const { runtime, agent } = makeAgent();
    await agent.handleCommand(
      cmd({
        type: 'server.start',
        payload: {
          deploymentId: 'd-1',
          nodeId: NODE_ID,
          dockerImage: 'nginx',
          resourceLimits: { cpuPercent: 50, ramPercent: 25, restartPolicy: 'on-failure' },
        },
      })
    );
    expect(runtime.lastStartSpec?.resourceLimits).toEqual({ cpuPercent: 50, ramPercent: 25, restartPolicy: 'on-failure' });
  });

  it('reports server.crashed when the runtime fails to start', async () => {
    const { runtime, published, agent } = makeAgent();
    runtime.failOn = 'start';
    await agent.handleCommand(
      cmd({ type: 'server.start', payload: { deploymentId: 'd-1', nodeId: NODE_ID, dockerImage: 'bad:image' } })
    );

    expect(published).toHaveLength(1);
    expect(published[0].key).toBe('infra.server.crashed');
    expect((published[0].envelope.event.payload as any).reason).toBe('image pull failed');
  });

  it('stops a container and reports server.stopped', async () => {
    const { runtime, published, agent } = makeAgent();
    await agent.handleCommand(
      cmd({ type: 'server.stop', payload: { deploymentId: 'd-1', nodeId: NODE_ID, containerId: 'c-9' } })
    );

    expect(runtime.calls).toEqual(['stop:c-9']);
    expect(published[0].key).toBe('infra.server.stopped');
    expect((published[0].envelope.event.payload as any).containerId).toBe('c-9');
  });

  it('restarts a container and reports server.started', async () => {
    const { runtime, published, agent } = makeAgent();
    await agent.handleCommand(
      cmd({ type: 'server.restart', payload: { deploymentId: 'd-1', nodeId: NODE_ID, containerId: 'c-9' } })
    );

    expect(runtime.calls).toEqual(['restart:c-9']);
    expect(published[0].key).toBe('infra.server.started');
  });

  it('ignores commands addressed to a different node', async () => {
    const { runtime, published, agent } = makeAgent();
    await agent.handleCommand(
      cmd({ type: 'server.start', payload: { deploymentId: 'd-1', nodeId: 'node-2', dockerImage: 'nginx' } })
    );

    expect(runtime.calls).toEqual([]);
    expect(published).toHaveLength(0);
  });

  it('decrypts encrypted command payloads before acting', async () => {
    process.env.FINVAULT_MESSAGE_KEY = 'shared-key';
    const { runtime, published, agent } = makeAgent();
    // Envelope built with the key set → payload is encrypted on the wire.
    const envelope = cmd({
      type: 'server.stop',
      payload: { deploymentId: 'd-2', nodeId: NODE_ID, containerId: 'c-enc' },
    });
    expect((envelope.event.payload as any).encrypted).toBe(true);

    await agent.handleCommand(envelope);
    expect(runtime.calls).toEqual(['stop:c-enc']);
    expect(published[0].key).toBe('infra.server.stopped');
  });
});
