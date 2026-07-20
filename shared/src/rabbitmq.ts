import * as amqp from 'amqplib';
import { EventEnvelope } from './events.js';

// NexusInfra publishes to and consumes from FinVault's exchange topology so the
// two platforms integrate with zero FinVault-side changes. Exchange + DLX names
// match FinVault/shared/src/rabbitmq.ts exactly.
const EXCHANGE = 'finvault.events';
const DLX = 'finvault.events.dlx';
const DLQ = 'finvault.events.dlq';

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const RABBITMQ_URL_WITH_DEFAULT = RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

let connection: any = null;
let channel: any = null;

export async function connectRabbitMQ(retryCount = 8, delayMs = 3000): Promise<{ connection: any; channel: any }> {
  if (connection && channel) {
    return { connection, channel };
  }

  if (!RABBITMQ_URL) {
    console.warn('[RabbitMQ] RABBITMQ_URL not set — skipping connection (async events disabled). Set RABBITMQ_URL to enable.');
    throw new Error('RABBITMQ_URL not configured');
  }

  for (let i = 1; i <= retryCount; i++) {
    try {
      console.log(`[RabbitMQ] Connecting to ${RABBITMQ_URL_WITH_DEFAULT} (Attempt ${i}/${retryCount})...`);
      const conn = await amqp.connect(RABBITMQ_URL_WITH_DEFAULT);
      const ch = await conn.createChannel();

      // Dead-letter exchange + queue (shared with FinVault)
      await ch.assertExchange(DLX, 'fanout', { durable: true });
      await ch.assertQueue(DLQ, { durable: true });
      await ch.bindQueue(DLQ, DLX, '');

      // Primary topic exchange (shared with FinVault)
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });

      console.log('[RabbitMQ] Successfully connected & exchanges asserted!');
      connection = conn;
      channel = ch;
      return { connection, channel };
    } catch (error: any) {
      console.error(`[RabbitMQ] Connection attempt ${i} failed:`, error.message);
      if (i === retryCount) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Could not connect to RabbitMQ');
}

export async function publishRabbitEvent(routingKey: string, envelope: EventEnvelope): Promise<boolean> {
  try {
    const { channel: ch } = await connectRabbitMQ();
    const message = Buffer.from(JSON.stringify(envelope));

    const success = ch.publish(EXCHANGE, routingKey, message, { persistent: true });

    if (success) {
      console.log(`[RabbitMQ Publish] Published ${envelope.event.type} with key: ${routingKey}`);
      return true;
    }
    console.error('[RabbitMQ Publish] Write buffer full, publish returned false.');
    return false;
  } catch (error: any) {
    console.error('[RabbitMQ Publish] Failed to publish event:', error.message);
    return false;
  }
}

export async function consumeRabbitQueue(
  queueName: string,
  topics: string[],
  onMessage: (envelope: EventEnvelope) => Promise<void>
): Promise<void> {
  try {
    const { channel: ch } = await connectRabbitMQ();

    await ch.assertQueue(queueName, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX },
    });

    for (const topic of topics) {
      await ch.bindQueue(queueName, EXCHANGE, topic);
      console.log(`[RabbitMQ Consume] Bound queue ${queueName} to topic: ${topic}`);
    }

    await ch.prefetch(1);

    await ch.consume(queueName, async (msg: any) => {
      if (!msg) return;
      try {
        const envelope = JSON.parse(msg.content.toString()) as EventEnvelope;
        console.log(`[RabbitMQ Consume] Processing ${envelope.event.type} from queue ${queueName}`);
        await onMessage(envelope);
        ch.ack(msg);
      } catch (error: any) {
        console.error(`[RabbitMQ Consume] Error processing message in queue ${queueName}:`, error.message);
        // Reject with no-requeue to trigger dead-lettering
        ch.nack(msg, false, false);
      }
    });

    console.log(`[RabbitMQ Consume] Started consuming from queue: ${queueName}`);
  } catch (error: any) {
    console.error('[RabbitMQ Consume] Setup failed:', error.message);
    throw error;
  }
}
