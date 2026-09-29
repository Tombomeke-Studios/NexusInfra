import { describe, it, expect, beforeEach } from 'vitest';
import { buildEnvelope, type NexusInfraEvent } from 'shared';
import { InMemoryRepository } from './repository.js';
import { createLifecycle } from './lifecycle.js';

async function seedDeployment(repo: InMemoryRepository) {
  const config = await repo.createServerConfig({ userId: 'u', name: 'svc', dockerImage: 'nginx' });
  return repo.createDeployment(config.id, 'node-local');
}

function report(event: NexusInfraEvent) {
  return buildEnvelope('node-agent:node-local', event);
}

describe('createLifecycle', () => {
  let repo: InMemoryRepository;
  let lifecycle: ReturnType<typeof createLifecycle>;

  beforeEach(() => {
    repo = new InMemoryRepository();
    lifecycle = createLifecycle(repo);
  });

  it('marks a deployment running on server.started', async () => {
    const d = await seedDeployment(repo);
    await lifecycle.handleReport(
      report({ type: 'server.started', payload: { deploymentId: d.id, containerId: 'abc123', nodeId: 'node-local' } })
    );

    const detail = await repo.getDeployment(d.id);
    expect(detail?.status).toBe('running');
    expect(detail?.containerId).toBe('abc123');
    expect(detail?.startedAt).not.toBeNull();
    expect(detail?.events.some((e) => e.event === 'started')).toBe(true);
  });

  it('marks a deployment stopped on server.stopped', async () => {
    const d = await seedDeployment(repo);
    await lifecycle.handleReport(report({ type: 'server.stopped', payload: { deploymentId: d.id, containerId: 'abc123' } }));

    const detail = await repo.getDeployment(d.id);
    expect(detail?.status).toBe('stopped');
    expect(detail?.stoppedAt).not.toBeNull();
  });

  it('forgets the container on server.stopped — the agent removed it (#321)', async () => {
    const d = await seedDeployment(repo);
    await repo.updateDeploymentStatus(d.id, { status: 'running', containerId: 'abc123' });
    await lifecycle.handleReport(report({ type: 'server.stopped', payload: { deploymentId: d.id, containerId: 'abc123' } }));

    expect((await repo.getDeployment(d.id))?.containerId).toBeNull();
  });

  it('ignores a late stop report for a container the server has since replaced (#321)', async () => {
    // Stop c1, start again as c2, and only then does c1's report arrive — an
    // outbox replay (#167) does exactly this. It must not stop c2 on paper.
    const d = await seedDeployment(repo);
    await repo.updateDeploymentStatus(d.id, { status: 'running', containerId: 'c2' });
    await lifecycle.handleReport(report({ type: 'server.stopped', payload: { deploymentId: d.id, containerId: 'c1' } }));

    const detail = await repo.getDeployment(d.id);
    expect(detail?.status).toBe('running');
    expect(detail?.containerId).toBe('c2');
    expect(detail?.events.some((e) => e.event === 'stopped')).toBe(false);
  });

  it('marks a deployment crashed on server.crashed and records the reason', async () => {
    const d = await seedDeployment(repo);
    await lifecycle.handleReport(
      report({ type: 'server.crashed', payload: { deploymentId: d.id, containerId: '', reason: 'image pull failed' } })
    );

    const detail = await repo.getDeployment(d.id);
    expect(detail?.status).toBe('crashed');
    expect(detail?.events.find((e) => e.event === 'crashed')?.message).toBe('image pull failed');
  });

  it('ignores reports for unknown deployments', async () => {
    await lifecycle.handleReport(report({ type: 'server.started', payload: { deploymentId: 'ghost', containerId: 'x', nodeId: 'n' } }));
    expect(await repo.listDeployments()).toHaveLength(0);
  });
});
