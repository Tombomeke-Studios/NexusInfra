import { describe, it, expect, vi } from 'vitest';
import { PublishOutbox, startOutboxFlusher } from './outbox.js';
import { buildEnvelope } from './events.js';
import type { EventEnvelope } from './events.js';

// A publisher whose success/failure is toggled per test, recording what landed.
function fakePublisher() {
  const delivered: Array<{ key: string; envelope: EventEnvelope }> = [];
  const state = { online: true };
  const publish = async (key: string, envelope: EventEnvelope) => {
    if (!state.online) return false;
    delivered.push({ key, envelope });
    return true;
  };
  return { publish, delivered, state };
}

const envelopeFor = (name: string) =>
  buildEnvelope('test', { type: 'heartbeat.service', payload: { name, status: 'healthy', timestamp: new Date().toISOString() } });

const deliveredNames = (delivered: Array<{ envelope: EventEnvelope }>) =>
  delivered.map((d) => (d.envelope.event.payload as { name: string }).name);

describe('PublishOutbox — normal delivery', () => {
  it('passes an event straight through while the broker is up', async () => {
    const p = fakePublisher();
    const outbox = new PublishOutbox(p.publish);

    await expect(outbox.publish('k', envelopeFor('a'))).resolves.toBe(true);
    expect(deliveredNames(p.delivered)).toEqual(['a']);
    expect(outbox.pending).toBe(0);
  });

  it('flushing an empty outbox is a no-op', async () => {
    const p = fakePublisher();
    const outbox = new PublishOutbox(p.publish);
    await expect(outbox.flush()).resolves.toBe(0);
    expect(p.delivered).toHaveLength(0);
  });
});

describe('PublishOutbox — buffering and replay', () => {
  it('buffers instead of dropping when the broker is down', async () => {
    const p = fakePublisher();
    const outbox = new PublishOutbox(p.publish);
    p.state.online = false;

    await expect(outbox.publish('k', envelopeFor('a'))).resolves.toBe(false);
    expect(p.delivered).toHaveLength(0);
    expect(outbox.pending).toBe(1); // held, not lost
  });

  it('replays buffered events in order once the broker returns', async () => {
    const p = fakePublisher();
    const outbox = new PublishOutbox(p.publish);

    p.state.online = false;
    await outbox.publish('k', envelopeFor('started'));
    await outbox.publish('k', envelopeFor('stopped'));
    expect(outbox.pending).toBe(2);

    p.state.online = true;
    expect(await outbox.flush()).toBe(2);
    // Order must survive the outage: started before stopped.
    expect(deliveredNames(p.delivered)).toEqual(['started', 'stopped']);
    expect(outbox.pending).toBe(0);
  });

  it('drains the backlog before a newly published event, keeping order', async () => {
    const p = fakePublisher();
    const outbox = new PublishOutbox(p.publish);

    p.state.online = false;
    await outbox.publish('k', envelopeFor('old'));

    p.state.online = true;
    await outbox.publish('k', envelopeFor('new'));

    expect(deliveredNames(p.delivered)).toEqual(['old', 'new']);
    expect(outbox.pending).toBe(0);
  });

  it('stops mid-flush on a fresh failure without scrambling order', async () => {
    const delivered: string[] = [];
    let failAfter = 1;
    const outbox = new PublishOutbox(async (_k, envelope) => {
      if (failAfter <= 0) return false;
      failAfter -= 1;
      delivered.push((envelope.event.payload as { name: string }).name);
      return true;
    });

    // Buffer three while "offline" (failAfter is 1, so the first publish succeeds).
    failAfter = 0;
    await outbox.publish('k', envelopeFor('one'));
    await outbox.publish('k', envelopeFor('two'));
    await outbox.publish('k', envelopeFor('three'));
    expect(outbox.pending).toBe(3);

    // Allow exactly one delivery, then fail again.
    failAfter = 1;
    expect(await outbox.flush()).toBe(1);
    expect(delivered).toEqual(['one']);
    // The undelivered two remain queued, still in order.
    expect(outbox.pending).toBe(2);

    failAfter = 5;
    await outbox.flush();
    expect(delivered).toEqual(['one', 'two', 'three']);
  });
});

describe('PublishOutbox — bounded memory', () => {
  it('drops the oldest events past capacity and counts the loss', async () => {
    const p = fakePublisher();
    const outbox = new PublishOutbox(p.publish, { capacity: 2 });
    p.state.online = false;

    await outbox.publish('k', envelopeFor('a'));
    await outbox.publish('k', envelopeFor('b'));
    await outbox.publish('k', envelopeFor('c')); // evicts 'a'

    expect(outbox.pending).toBe(2);
    expect(outbox.droppedCount).toBe(1); // loss is reported, not silent

    p.state.online = true;
    await outbox.flush();
    expect(deliveredNames(p.delivered)).toEqual(['b', 'c']);
  });

  it('treats a thrown publisher error as a failure and buffers', async () => {
    const outbox = new PublishOutbox(async () => {
      throw new Error('connection reset');
    });
    await expect(outbox.publish('k', envelopeFor('a'))).resolves.toBe(false);
    expect(outbox.pending).toBe(1);
  });
});

describe('startOutboxFlusher', () => {
  it('drains the backlog on its timer without a new publish', async () => {
    vi.useFakeTimers();
    try {
      const p = fakePublisher();
      const outbox = new PublishOutbox(p.publish);

      p.state.online = false;
      await outbox.publish('k', envelopeFor('a'));
      expect(outbox.pending).toBe(1);

      const stop = startOutboxFlusher(outbox, 1000);
      p.state.online = true;

      await vi.advanceTimersByTimeAsync(1000);
      expect(outbox.pending).toBe(0);
      expect(deliveredNames(p.delivered)).toEqual(['a']);

      stop();
      // After stopping, the timer no longer runs.
      p.state.online = false;
      await outbox.publish('k', envelopeFor('b'));
      p.state.online = true;
      await vi.advanceTimersByTimeAsync(5000);
      expect(outbox.pending).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
