import { describe, it, expect } from 'vitest';
import {
  nodeCapacity,
  committedRamMb,
  committedCpuCores,
  availableRamMb,
  availableCpuCores,
  isOverCommitted,
} from './capacity.js';
import type { DeploymentView, NodeRecord } from './types.js';

// Total, committed and used are three different numbers, and the form that
// decides how much to give a new server was reading the wrong one (#275).

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'node-1',
    name: 'node-1',
    location: null,
    ipAddress: null,
    agentUrl: null,
    lastHeartbeat: new Date().toISOString(),
    cpuPercent: 5,
    cpuCores: 8,
    ramUsedMb: 6000, // Linux spends spare RAM on page cache: "used" is not "taken".
    ramTotalMb: 8192,
    diskUsedGb: null,
    diskTotalGb: null,
    maintenance: false,
    ...overrides,
  };
}

function server(id: string, limits: DeploymentView['resourceLimits'], nodeId = 'node-1'): DeploymentView {
  return {
    id,
    serverConfigId: `cfg-${id}`,
    nodeId,
    containerId: null,
    status: 'running',
    startedAt: null,
    stoppedAt: null,
    createdAt: new Date().toISOString(),
    name: id,
    dockerImage: 'nginx',
    userId: 'u1',
    teamId: null,
    type: 'generic',
    resourceLimits: limits,
  };
}

describe('committedRamMb', () => {
  it('takes an absolute value as given', () => {
    expect(committedRamMb({ ramMb: 2048 }, 8192)).toBe(2048);
  });

  it('resolves a percentage against the node', () => {
    expect(committedRamMb({ ramPercent: 25 }, 8192)).toBe(2048);
  });

  it('prefers the absolute value over the percentage', () => {
    expect(committedRamMb({ ramMb: 1024, ramPercent: 50 }, 8192)).toBe(1024);
  });

  it('counts an uncapped server as zero rather than inventing a figure', () => {
    // It can take the whole node, but there is no honest number to add.
    expect(committedRamMb({}, 8192)).toBe(0);
    expect(committedRamMb(undefined, 8192)).toBe(0);
  });

  it('cannot resolve a percentage on a node that has not reported its RAM', () => {
    expect(committedRamMb({ ramPercent: 50 }, null)).toBe(0);
  });
});

describe('committedCpuCores', () => {
  it('handles both units, including fractional cores', () => {
    expect(committedCpuCores({ cpuCores: 1.5 }, 8)).toBe(1.5);
    expect(committedCpuCores({ cpuPercent: 50 }, 8)).toBe(4);
    expect(committedCpuCores({ cpuCores: 1, cpuPercent: 100 }, 8)).toBe(1);
    expect(committedCpuCores({}, 8)).toBe(0);
  });
});

describe('nodeCapacity', () => {
  it('separates what the node has, has promised, and is using', () => {
    const capacity = nodeCapacity(node(), [
      server('a', { ramMb: 2048, cpuCores: 2 }),
      server('b', { ramPercent: 25, cpuPercent: 25 }), // 2048 MB, 2 cores
    ]);

    expect(capacity.ramTotalMb).toBe(8192);
    expect(capacity.ramCommittedMb).toBe(4096);
    expect(capacity.ramUsedMb).toBe(6000); // higher than committed, and irrelevant to the decision
    expect(capacity.cpuCoresTotal).toBe(8);
    expect(capacity.cpuCoresCommitted).toBe(4);
  });

  it('ignores servers placed on other nodes', () => {
    const capacity = nodeCapacity(node(), [server('a', { ramMb: 2048 }), server('elsewhere', { ramMb: 4096 }, 'node-2')]);
    expect(capacity.ramCommittedMb).toBe(2048);
  });

  it('counts a stopped server, which keeps its cap', () => {
    // Starting it again must not need capacity given away in the meantime.
    const stopped = { ...server('a', { ramMb: 2048 }), status: 'stopped' as const };
    expect(nodeCapacity(node(), [stopped]).ramCommittedMb).toBe(2048);
  });

  it('reports nothing committed on an empty node', () => {
    const capacity = nodeCapacity(node(), []);
    expect(capacity.ramCommittedMb).toBe(0);
    expect(capacity.cpuCoresCommitted).toBe(0);
  });

  it('leaves totals null when the node has not reported its hardware', () => {
    const capacity = nodeCapacity(node({ ramTotalMb: null, cpuCores: null }), []);
    expect(capacity.ramTotalMb).toBeNull();
    expect(capacity.cpuCoresTotal).toBeNull();
  });
});

describe('what is left', () => {
  it('is total minus committed, not total minus used', () => {
    // The whole point: four idle servers still leave nothing to give away.
    const capacity = nodeCapacity(node({ ramUsedMb: 500 }), [
      server('a', { ramMb: 2048 }),
      server('b', { ramMb: 2048 }),
      server('c', { ramMb: 2048 }),
      server('d', { ramMb: 2048 }),
    ]);
    expect(availableRamMb(capacity)).toBe(0);
  });

  it('is not fooled by page cache into reporting a node full', () => {
    // A node running nothing reports most of its RAM used; all of it is available.
    const capacity = nodeCapacity(node({ ramUsedMb: 7800 }), []);
    expect(availableRamMb(capacity)).toBe(8192);
  });

  it('never goes negative on an over-committed node', () => {
    const capacity = nodeCapacity(node(), [server('a', { ramMb: 16384, cpuCores: 32 })]);
    expect(availableRamMb(capacity)).toBe(0);
    expect(availableCpuCores(capacity)).toBe(0);
    expect(isOverCommitted(capacity)).toBe(true);
  });

  it('is null when the node has not said how much it has', () => {
    const capacity = nodeCapacity(node({ ramTotalMb: null, cpuCores: null }), []);
    expect(availableRamMb(capacity)).toBeNull();
    expect(availableCpuCores(capacity)).toBeNull();
    expect(isOverCommitted(capacity)).toBe(false);
  });

  it('rounds fractional cores to something readable', () => {
    const capacity = nodeCapacity(node(), [server('a', { cpuCores: 1.1 }), server('b', { cpuCores: 2.2 })]);
    expect(capacity.cpuCoresCommitted).toBe(3.3);
    expect(availableCpuCores(capacity)).toBe(4.7);
  });
});
