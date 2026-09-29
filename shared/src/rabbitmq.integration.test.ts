import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';

// The event bus against a real broker (#242): bindings, encryption on the wire,
// dead-lettering. Unit tests prove the envelope and the cipher; only a broker
// proves a message published under one key reaches a queue bound to it, and a
// failed consumer's message lands in the DLQ rather than disappearing.

const URL = process.env.RABBITMQ_URL;
// CI sets REQUIRE_BROKER, so a job that lost its broker fails instead of
// skipping — a green run that tested nothing is the failure this suite exists
// to prevent.
if (process.env.REQUIRE_BROKER && !URL) throw new Error('REQUIRE_BROKER is set but RABBITMQ_URL is not');
const KEY = 'integration-test-key-0123456789abcdef';

describe.skipIf(!URL)('RabbitMQ (#242)', () => {
  let shared: typeof import('./index.js');
  let raw: amqp.Connection;
  let rawChannel: amqp.Channel;

  beforeAll(async () => {
    process.env.FINVAULT_MESSAGE_KEY = KEY;
    shared = await import('./index.js');
    // The app's own topology first. A fresh broker has no `finvault.events`
    // until a service connects, and the tap below binds to it directly — this
    // passed against a broker the running stack had already set up, and failed
    // on CI's empty one.
    await shared.connectRabbitMQ(1, 0);
    raw = await amqp.connect(URL!);
    rawChannel = await raw.createChannel();
  });

  afterAll(async () => {
    await rawChannel?.close().catch(() => undefined);
    await raw?.close().catch(() => undefined);
  });

  /** A queue bound to one routing key on the shared exchange, for peeking at what went over the wire. */
  async function tap(routingKey: string): Promise<string> {
    const { queue } = await rawChannel.assertQueue('', { exclusive: true, autoDelete: true });
    await rawChannel.bindQueue(queue, 'finvault.events', routingKey);
    return queue;
  }

  async function next(queue: string, timeoutMs = 10_000): Promise<amqp.GetMessage> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const msg = await rawChannel.get(queue, { noAck: true });
      if (msg) return msg;
      if (Date.now() > until) throw new Error(`nothing arrived on ${queue}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('delivers to a queue bound to the key, with the payload encrypted in transit', async () => {
    const key = `test.integration.${randomUUID()}`;
    const onWire = await tap(key);
    const received: Record<string, unknown>[] = [];
    await shared.consumeRabbitQueue(`nexusinfra.test.${randomUUID()}`, [key], async (envelope) => {
      received.push(shared.readPayload(envelope.event));
    });

    const secret = `plaintext-marker-${randomUUID()}`;
    const sent = await shared.publishRabbitEvent(
      key,
      shared.buildEnvelope('integration', { type: 'server.crashed', payload: { deploymentId: 'd1', containerId: 'c1', reason: secret } }),
    );
    expect(sent).toBe(true);

    // What actually crossed the broker is ciphertext: the marker is nowhere in it.
    const wire = (await next(onWire)).content.toString();
    expect(wire).not.toContain(secret);
    expect(JSON.parse(wire).event.type).toBe('server.crashed');

    // And the consumer, holding the same key, reads it back.
    for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ deploymentId: 'd1', containerId: 'c1', reason: secret }]);
  });

  it('does not deliver to a queue bound to a different key', async () => {
    const onOther = await tap(`test.integration.other.${randomUUID()}`);
    await shared.publishRabbitEvent(`test.integration.${randomUUID()}`, shared.buildEnvelope('integration', { type: 'deployment.failed', payload: { deploymentId: 'x', reason: 'r' } }));
    await new Promise((r) => setTimeout(r, 500));
    expect(await rawChannel.get(onOther, { noAck: true })).toBe(false);
  });

  it('dead-letters a message whose consumer fails, instead of losing it', async () => {
    const key = `test.integration.dlq.${randomUUID()}`;
    const marker = randomUUID();
    await shared.consumeRabbitQueue(`nexusinfra.test.${randomUUID()}`, [key], async () => {
      throw new Error('consumer failure, on purpose');
    });
    await shared.publishRabbitEvent(key, shared.buildEnvelope('integration', { type: 'deployment.failed', payload: { deploymentId: marker, reason: 'x' } }));

    // The DLQ is shared: look for ours and put anything else back.
    const until = Date.now() + 10_000;
    let found = false;
    while (!found && Date.now() < until) {
      const msg = await rawChannel.get('finvault.events.dlq', { noAck: false });
      if (!msg) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const payload = shared.readPayload(JSON.parse(msg.content.toString()).event);
      if (payload.deploymentId === marker) {
        found = true;
        rawChannel.ack(msg);
      } else {
        rawChannel.nack(msg, false, true);
      }
    }
    expect(found).toBe(true);
  });
});
