import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';
import { backfillPortAllocations } from './portAllocation.js';
import { PortConflictError } from './portPool.js';

describe('port allocations in the repository (#233)', () => {
  let repo: InMemoryRepository;
  const server = async (name: string, ports: Record<string, string>, nodeId = 'node-a') => {
    const config = await repo.createServerConfig({ userId: 'u', name, dockerImage: 'x', ports });
    return (await repo.createDeployment(config.id, nodeId)).id;
  };

  beforeEach(() => {
    repo = new InMemoryRepository();
  });

  it('refuses a port another server holds on the same node, and writes nothing', async () => {
    const a = await server('a', {});
    const b = await server('b', {});
    await repo.replacePortAllocations(a, 'node-a', [8080]);
    await expect(repo.replacePortAllocations(b, 'node-a', [9090, 8080])).rejects.toBeInstanceOf(PortConflictError);
    expect(await repo.listPortAllocations({ deploymentId: b })).toEqual([]);
  });

  it('keeps the primary when its port survives a change, and falls back to the first otherwise', async () => {
    const a = await server('a', {});
    await repo.replacePortAllocations(a, 'node-a', [1000, 2000]);
    await repo.setPrimaryPort(a, 2000);
    await repo.replacePortAllocations(a, 'node-a', [2000, 3000]);
    expect((await repo.listPortAllocations({ deploymentId: a })).find((x) => x.primary)?.port).toBe(2000);
    await repo.replacePortAllocations(a, 'node-a', [4000, 5000]);
    expect((await repo.listPortAllocations({ deploymentId: a })).find((x) => x.primary)?.port).toBe(4000);
  });

  it('records what servers from before #233 hold, once, and leaves an existing clash to its owner', async () => {
    await repo.upsertNode({ id: 'node-a', lastHeartbeat: new Date().toISOString() });
    const first = await server('first', { '25565': '25565' });
    const second = await server('second', { '25565': '25565', '25575': '25575' });

    expect(await backfillPortAllocations(repo)).toBe(2);
    expect((await repo.listPortAllocations({ deploymentId: first })).map((x) => x.port)).toEqual([25565]);
    expect((await repo.listPortAllocations({ deploymentId: second })).map((x) => x.port)).toEqual([25575]);
    expect(await backfillPortAllocations(repo)).toBe(0);
  });

  it('forgets the ports of a deregistered node', async () => {
    await repo.upsertNode({ id: 'node-a', lastHeartbeat: new Date().toISOString() });
    const a = await server('a', {});
    await repo.replacePortAllocations(a, 'node-a', [8080]);
    await repo.deleteNode('node-a');
    expect(await repo.listPortAllocations({})).toEqual([]);
  });
});
