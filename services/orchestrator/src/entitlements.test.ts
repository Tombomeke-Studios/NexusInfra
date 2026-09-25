import { describe, it, expect } from 'vitest';
import { ramChangeProblem, ramProblem, serverRamMb, usageFor, type Entitlements } from './entitlements.js';
import type { DeploymentView, NodeRecord } from './types.js';

// #297: a hosted plan's memory ceiling, measured against what the account holds.

const plan = (over: Partial<Entitlements> = {}): Entitlements => ({
  planId: 'standard',
  planName: 'Standard',
  maxServers: 5,
  maxDatabases: 5,
  maxRamMb: 8192,
  maxBackupsPerServer: 10,
  charging: { basis: 'runtime-hours', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, sizeFactor: { standardCpuPercent: 50, standardRamPercent: 50, minimum: 0.25 } },
  ...over,
});

const node = (id: string, ramTotalMb: number | undefined): NodeRecord => ({ id, lastHeartbeat: new Date().toISOString(), ramTotalMb }) as NodeRecord;

function server(id: string, userId: string, nodeId: string, resourceLimits: DeploymentView['resourceLimits']): DeploymentView {
  return { id, userId, nodeId, resourceLimits, serverConfigId: `c-${id}`, containerId: null, status: 'running', startedAt: null, stoppedAt: null, createdAt: '', name: id, dockerImage: 'nginx', teamId: null, type: 'generic' } as DeploymentView;
}

const nodes = [node('n1', 16384), node('n2', 4096), node('blind', undefined)];

describe('usageFor', () => {
  it('adds up the memory of the account’s own servers, in MB, on their own nodes', () => {
    const usage = usageFor(
      'u1',
      [
        server('a', 'u1', 'n1', { ramMb: 2048 }),
        server('b', 'u1', 'n2', { ramPercent: 50 }), // 2048 MB of a 4 GB node
        server('c', 'u2', 'n1', { ramMb: 4096 }), // somebody else's
      ],
      nodes,
      3
    );
    expect(usage).toEqual({ servers: 2, databases: 3, ramMb: 4096, uncappedServers: 0 });
  });

  it('counts a server it cannot measure as uncapped rather than as zero memory', () => {
    const usage = usageFor('u1', [server('a', 'u1', 'n1', {}), server('b', 'u1', 'blind', { ramPercent: 25 })], nodes, 0);
    expect(usage).toMatchObject({ servers: 2, ramMb: 0, uncappedServers: 2 });
  });

  it('leaves out the server being changed', () => {
    const usage = usageFor('u1', [server('a', 'u1', 'n1', { ramMb: 2048 }), server('b', 'u1', 'n1', { ramMb: 1024 })], nodes, 0, 'b');
    expect(usage).toMatchObject({ servers: 1, ramMb: 2048 });
  });

  it('converts a percentage cap on the node it runs on', () => {
    expect(serverRamMb(server('a', 'u1', 'n1', { ramPercent: 25 }), nodes)).toBe(4096);
    expect(serverRamMb(server('a', 'u1', 'n2', { ramPercent: 25 }), nodes)).toBe(1024);
  });
});

describe('ramProblem', () => {
  const used = (ramMb: number) => ({ servers: 1, databases: 0, ramMb, uncappedServers: 0 });

  it('allows a server that fits what is left', () => {
    expect(ramProblem(plan(), used(6144), 2048)).toBeNull();
  });

  it('refuses one that does not, naming the numbers', () => {
    expect(ramProblem(plan(), used(6144), 3072)).toBe('this server needs 3 GB of memory, and your plan has 2 GB of its 8 GB left');
  });

  it('refuses an uncapped server under a memory ceiling', () => {
    // It could take the whole node — counted as zero it would spend every
    // account's memory; counted as anything else it would be an invented number.
    expect(ramProblem(plan(), used(0), 0)).toMatch(/needs a memory limit/);
  });

  it('applies nothing without a plan or without a ceiling', () => {
    expect(ramProblem(null, used(99999), 99999)).toBeNull();
    expect(ramProblem(plan({ maxRamMb: null }), used(99999), 0)).toBeNull();
  });

  it('says there is nothing left rather than a negative amount', () => {
    expect(ramProblem(plan(), used(9000), 512)).toBe('this server needs 512 MB of memory, and your plan has 0 MB of its 8 GB left');
  });
});

describe('ramChangeProblem', () => {
  const others = { servers: 1, databases: 0, ramMb: 7168, uncappedServers: 0 };

  it('refuses growing past the plan', () => {
    expect(ramChangeProblem(plan(), others, 512, 2048)).toMatch(/needs 2 GB/);
  });

  it('allows shrinking even while still over the plan', () => {
    // The plan shrank, or a node grew under a percentage cap: refusing a step
    // in the right direction would leave no way back.
    expect(ramChangeProblem(plan(), { ...others, ramMb: 12000 }, 4096, 2048)).toBeNull();
  });

  it('refuses removing the cap', () => {
    expect(ramChangeProblem(plan(), others, 512, 0)).toMatch(/needs a memory limit/);
  });

  it('does not measure a server that was uncapped and gets a cap', () => {
    // Uncapped servers from before the plan had a ceiling may only get *more*
    // measurable, and that is the change to encourage.
    expect(ramChangeProblem(plan(), others, 0, 4096)).toBeNull();
  });
});
