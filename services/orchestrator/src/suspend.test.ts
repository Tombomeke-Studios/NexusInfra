import { describe, it, expect, beforeEach } from 'vitest';
import { readPayload, type EventEnvelope } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createSuspendHandler } from './suspend.js';

// The suspend handler stops each still-running deployment named in a
// billing.server.suspend event and records it. No broker needed.

describe('billing.server.suspend handler', () => {
  let repo: InMemoryRepository;
  let published: Array<{ key: string; envelope: EventEnvelope }>;
  let handleSuspend: ReturnType<typeof createSuspendHandler>;

  beforeEach(() => {
    repo = new InMemoryRepository();
    published = [];
    handleSuspend = createSuspendHandler({ repo, publish: async (key, envelope) => { published.push({ key, envelope }); return true; } });
  });

  async function runningDeployment(name: string) {
    const config = await repo.createServerConfig({ userId: 'u1', name, dockerImage: 'nginx' });
    const dep = await repo.createDeployment(config.id, 'node-1');
    await repo.updateDeploymentStatus(dep.id, { status: 'running', containerId: `c-${name}` });
    return dep.id;
  }

  it('emits infra.server.stop for each running deployment and audits it', async () => {
    const a = await runningDeployment('a');
    const b = await runningDeployment('b');

    await handleSuspend({ userId: 'u1', deploymentIds: [a, b], reason: 'credit exhausted' });

    const stops = published.filter((p) => p.key === 'infra.server.stop');
    expect(stops).toHaveLength(2);
    expect(readPayload(stops[0].envelope.event).containerId).toBe('c-a');

    const detail = await repo.getDeployment(a);
    expect(detail?.events.some((e) => e.event === 'suspended')).toBe(true);
  });

  // #380: a suspended server must not look like one its owner stopped.
  it('records the suspension with the server, not only in the audit trail', async () => {
    const a = await runningDeployment('a');
    await handleSuspend({ userId: 'u1', deploymentIds: [a], reason: 'credit exhausted' });
    const detail = await repo.getDeployment(a);
    expect(detail?.suspendedReason).toBe('credit exhausted');
    expect(detail?.suspendedAt).toEqual(expect.any(String));
  });

  it('does not mark a server it did not stop', async () => {
    const config = await repo.createServerConfig({ userId: 'u1', name: 'idle', dockerImage: 'nginx' });
    const dep = await repo.createDeployment(config.id, 'node-1');
    await handleSuspend({ userId: 'u1', deploymentIds: [dep.id], reason: 'credit exhausted' });
    expect((await repo.getDeployment(dep.id))?.suspendedAt).toBeNull();
  });

  it('skips deployments that are not running or unknown', async () => {
    const config = await repo.createServerConfig({ userId: 'u1', name: 'stopped', dockerImage: 'nginx' });
    const dep = await repo.createDeployment(config.id, 'node-1'); // pending, no container

    await handleSuspend({ userId: 'u1', deploymentIds: [dep.id, 'ghost'], reason: 'credit exhausted' });

    expect(published).toHaveLength(0);
  });
});
