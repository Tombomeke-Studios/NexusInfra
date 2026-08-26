import { describe, it, expect } from 'vitest';
import { selectNode, nodeLoad } from './nodeSelection.js';
import type { NodeRecord } from './types.js';

const t0 = new Date('2026-07-21T00:00:00.000Z').getTime();

function node(id: string, overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    name: id,
    ipAddress: null,
    lastHeartbeat: new Date(t0).toISOString(),
    cpuPercent: 10,
    ramUsedMb: 1000,
    ramTotalMb: 8000,
    diskUsedGb: null,
    diskTotalGb: null,
    ...overrides,
  };
}

describe('selectNode', () => {
  const now = t0 + 1000; // 1s later — all fresh nodes are healthy

  it('returns null when there are no nodes', () => {
    expect(selectNode([], now)).toBeNull();
  });

  it('returns null when no node is healthy', () => {
    const stale = node('n1', { lastHeartbeat: new Date(t0 - 20000).toISOString() });
    expect(selectNode([stale], now)).toBeNull();
  });

  it('picks the least-loaded healthy node', () => {
    const busy = node('busy', { cpuPercent: 90, ramUsedMb: 7000, ramTotalMb: 8000 });
    const idle = node('idle', { cpuPercent: 5, ramUsedMb: 500, ramTotalMb: 8000 });
    expect(selectNode([busy, idle], now)?.id).toBe('idle');
  });

  it('skips offline nodes even if they look idle', () => {
    const idleButOffline = node('offline', { cpuPercent: 1, lastHeartbeat: new Date(t0 - 20000).toISOString() });
    const healthy = node('healthy', { cpuPercent: 50 });
    expect(selectNode([idleButOffline, healthy], now)?.id).toBe('healthy');
  });

  it('breaks ties deterministically by id', () => {
    const a = node('bbb', { cpuPercent: 20, ramUsedMb: 1000, ramTotalMb: 8000 });
    const b = node('aaa', { cpuPercent: 20, ramUsedMb: 1000, ramTotalMb: 8000 });
    expect(selectNode([a, b], now)?.id).toBe('aaa');
  });
});

describe('nodeLoad', () => {
  it('sums CPU and RAM fractions', () => {
    expect(nodeLoad(node('n', { cpuPercent: 50, ramUsedMb: 4000, ramTotalMb: 8000 }))).toBeCloseTo(1.0);
  });
  it('defaults unknown metrics to 0.5', () => {
    expect(nodeLoad(node('n', { cpuPercent: null, ramUsedMb: null, ramTotalMb: null }))).toBeCloseTo(1.0);
  });
});

// A node in maintenance is being drained on purpose — it is still healthy and
// still runs what it has, but must not receive anything new (#258). Before this,
// maintenance lived only in the browser tab and placement ignored it entirely.
describe('selectNode and maintenance', () => {
  const now = t0 + 1000;

  it('never places on a node in maintenance', () => {
    const draining = node('n-drain', { cpuPercent: 1, ramUsedMb: 100, maintenance: true });
    const busy = node('n-busy', { cpuPercent: 80, ramUsedMb: 7000 });

    // The draining node is by far the emptiest, and still must not win.
    expect(selectNode([draining, busy], now)?.id).toBe('n-busy');
  });

  it('returns null when every healthy node is in maintenance', () => {
    expect(selectNode([node('n1', { maintenance: true }), node('n2', { maintenance: true })], now)).toBeNull();
  });

  it('places normally once maintenance is lifted', () => {
    const back = node('n-drain', { cpuPercent: 1, ramUsedMb: 100, maintenance: false });
    const busy = node('n-busy', { cpuPercent: 80, ramUsedMb: 7000 });
    expect(selectNode([back, busy], now)?.id).toBe('n-drain');
  });
});
