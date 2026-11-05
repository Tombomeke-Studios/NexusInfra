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

  it('reports an outbound agent as such, with no address (#416)', async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const publish = async (_key: string, envelope: EventEnvelope) => {
      payloads.push(envelope.event.payload as Record<string, unknown>);
      return true;
    };
    const stopOutbound = startNodeHeartbeat('node-1', async () => RESOURCES, { agentUrl: 'http://10.0.0.5:9100', outbound: true, publish });
    const stopDirect = startNodeHeartbeat('node-2', async () => RESOURCES, { agentUrl: 'http://10.0.0.6:9100', publish });
    await vi.advanceTimersByTimeAsync(0);
    stopOutbound();
    stopDirect();

    expect(payloads[0]).toMatchObject({ nodeId: 'node-1', connection: 'outbound' });
    expect(payloads[0].agentUrl).toBeUndefined();
    // A direct agent's pulse is what it always was.
    expect(payloads[1]).toMatchObject({ nodeId: 'node-2', agentUrl: 'http://10.0.0.6:9100' });
    expect('connection' in payloads[1]).toBe(false);
  });
});
