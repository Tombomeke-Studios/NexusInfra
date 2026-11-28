import { describe, expect, it } from 'vitest';
import { logsTraffic, redactUrl } from './rabbitmq.js';

describe('redactUrl (#394)', () => {
  it('hides the password of a broker URL and keeps where it points', () => {
    const logged = redactUrl('amqp://nexus:s3cr3t-pass@rabbitmq:5672');
    expect(logged).not.toContain('s3cr3t-pass');
    expect(logged).toBe('amqp://nexus:***@rabbitmq:5672');
  });

  it('hides the password of a database URL, query and path included', () => {
    const logged = redactUrl('postgresql://app:hunter2@db.internal:5432/nexus?schema=public');
    expect(logged).not.toContain('hunter2');
    expect(logged).toBe('postgresql://app:***@db.internal:5432/nexus?schema=public');
  });

  it('hides a percent-encoded password', () => {
    expect(redactUrl('amqps://u:p%40ss%3Aword@broker/vhost')).toBe('amqps://u:***@broker/vhost');
  });

  it('leaves a URL with no password as it was', () => {
    expect(redactUrl('amqp://rabbitmq:5672')).toBe('amqp://rabbitmq:5672');
    expect(redactUrl('file:/data/orchestrator.db')).toBe('file:/data/orchestrator.db');
  });

  it('still cuts the credentials out of something that does not parse', () => {
    const logged = redactUrl('amqp://user:pa ss@[not-a-host');
    expect(logged).not.toContain('pa ss');
    expect(logged).toBe('amqp://user:***@[not-a-host');
  });
});

describe('logsTraffic (#395)', () => {
  it('keeps heartbeats out of the log', () => {
    expect(logsTraffic('heartbeat.service')).toBe(false);
    expect(logsTraffic('heartbeat.node')).toBe(false);
  });

  it('still logs every other event', () => {
    for (const type of ['server.start', 'server.crashed', 'node.inventory', 'payment.request']) {
      expect(logsTraffic(type)).toBe(true);
    }
  });
});

import { EventEmitter } from 'node:events';
import { createBroker, reconnectDelayMs } from './rabbitmq.js';
import { buildEnvelope } from './events.js';

/** A fake amqplib connection: enough surface for the broker, and a way to kill it. */
function fakeConnection() {
  const consumers: { queue: string; onMessage: (msg: unknown) => void }[] = [];
  const published: { key: string; body: string }[] = [];
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: async () => undefined,
    assertQueue: async () => undefined,
    bindQueue: async () => undefined,
    prefetch: async () => undefined,
    consume: async (queue: string, onMessage: (msg: unknown) => void) => void consumers.push({ queue, onMessage }),
    publish: (_ex: string, key: string, body: Buffer) => (published.push({ key, body: body.toString() }), true),
    ack: () => undefined,
    nack: () => undefined,
  });
  const connection = Object.assign(new EventEmitter(), {
    createChannel: async () => channel,
    close: async () => undefined,
  });
  return { connection, channel, consumers, published };
}

function harness() {
  const opened: ReturnType<typeof fakeConnection>[] = [];
  let failing = false;
  const timers: (() => void)[] = [];
  const broker = createBroker({
    url: 'amqp://broker',
    connect: async () => {
      if (failing) throw new Error('ECONNREFUSED');
      const c = fakeConnection();
      opened.push(c);
      return c.connection;
    },
    setTimer: (fn) => void timers.push(fn),
    log: () => undefined,
    warn: () => undefined,
  });
  const runTimers = async () => {
    while (timers.length) timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  return { broker, opened, timers, runTimers, setFailing: (v: boolean) => (failing = v) };
}

const envelope = () => buildEnvelope('test', { type: 'server.crashed', payload: { deploymentId: 'd1', containerId: 'c1', reason: 'x' } });

describe('reconnecting to the broker (#448)', () => {
  it('backs off from 1 s, doubling, to at most 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('reopens after the broker goes away and sets every consumer up again', async () => {
    const h = harness();
    await h.broker.consume('q.orchestrator', ['infra.#'], async () => undefined);
    expect(h.opened[0].consumers.map((c) => c.queue)).toEqual(['q.orchestrator']);

    h.opened[0].connection.emit('close');
    expect(h.broker.state().connected).toBe(false);
    await h.runTimers();

    expect(h.opened).toHaveLength(2);
    expect(h.opened[1].consumers.map((c) => c.queue)).toEqual(['q.orchestrator']);
    expect(h.broker.state()).toEqual({ connected: true, reconnects: 1 });
  });

  it('treats a channel closing on its own as a lost connection', async () => {
    const h = harness();
    await h.broker.consume('q', ['a'], async () => undefined);
    h.opened[0].channel.emit('close');
    await h.runTimers();
    expect(h.opened).toHaveLength(2);
  });

  it('answers a publish while disconnected with false at once, and publishes again once back', async () => {
    const h = harness();
    await h.broker.connect(1, 0);
    h.opened[0].connection.emit('close');
    expect(await h.broker.publish('k', envelope())).toBe(false);
    await h.runTimers();
    expect(await h.broker.publish('k', envelope())).toBe(true);
    expect(h.opened[1].published).toHaveLength(1);
  });

  it('keeps trying while the broker stays down', async () => {
    const h = harness();
    await h.broker.connect(1, 0);
    h.setFailing(true);
    h.opened[0].connection.emit('close');
    await h.runTimers(); // fails, schedules the next
    expect(h.timers).toHaveLength(1);
    h.setFailing(false);
    await h.runTimers();
    expect(h.broker.state().connected).toBe(true);
  });

  it('sets up a consumer registered while the broker was unreachable once it can', async () => {
    const h = harness();
    h.setFailing(true);
    // Start-up: the broker is not there yet. This used to drop the consumer for good.
    await h.broker.consume('q.late', ['x'], async () => undefined).catch(() => undefined);
    h.setFailing(false);
    await h.runTimers();
    expect(h.opened.at(-1)!.consumers.map((c) => c.queue)).toEqual(['q.late']);
  });

  it('ignores the last words of a connection it already replaced', async () => {
    const h = harness();
    await h.broker.connect(1, 0);
    const old = h.opened[0];
    old.connection.emit('close');
    await h.runTimers();
    old.channel.emit('close'); // late event from the dead connection
    expect(h.broker.state().connected).toBe(true);
    expect(h.timers).toHaveLength(0);
  });
});
