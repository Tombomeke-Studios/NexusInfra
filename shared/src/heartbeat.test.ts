import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startNodeHeartbeat } from './heartbeat.js';
import type { EventEnvelope, NodeResources } from './events.js';

const RESOURCES: NodeResources = {
  cpuPercent: 12.5,
  ramUsedMb: 2048,
  ramTotalMb: 8192,
  diskUsedGb: 0,
  diskTotalGb: 0,
};

describe('startNodeHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.FINVAULT_MESSAGE_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('publishes on monitoring.heartbeat.node.{id} with resources on the first pulse', async () => {
    const published: Array<{ key: string; envelope: EventEnvelope }> = [];
    const collect = vi.fn(async () => RESOURCES);

    const stop = startNodeHeartbeat('node-1', collect, {
      beatMs: 1000,
      resourceMs: 5000,
      publish: async (key, envelope) => {
        published.push({ key, envelope });
        return true;
      },
    });

    await vi.advanceTimersByTimeAsync(0); // flush the immediate first beat
    expect(published).toHaveLength(1);
    expect(published[0].key).toBe('monitoring.heartbeat.node.node-1');
    expect(published[0].envelope.event.type).toBe('heartbeat.node');
    expect((published[0].envelope.event.payload as any).resources).toEqual(RESOURCES);

    stop();
  });

  it('sends lightweight pulses between resource snapshots (5s cadence)', async () => {
    const published: Array<{ key: string; envelope: EventEnvelope }> = [];
    const collect = vi.fn(async () => RESOURCES);

    const stop = startNodeHeartbeat('node-1', collect, {
      beatMs: 1000,
      resourceMs: 5000,
      publish: async (key, envelope) => {
        published.push({ key, envelope });
        return true;
      },
    });

    // First beat (with resources) + 5 interval beats = 6 pulses total.
    await vi.advanceTimersByTimeAsync(5000);
    expect(published).toHaveLength(6);

    // Beats at 1s..4s carry no resources; the 5s beat carries them.
    const withResources = published.filter((p) => (p.envelope.event.payload as any).resources);
    expect(withResources).toHaveLength(2); // t=0 and t=5000
    expect(collect).toHaveBeenCalledTimes(2);

    stop();
  });
});
