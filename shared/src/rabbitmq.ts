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

/**
 * A connection URL fit for a log line: the password is replaced, everything else
 * kept so the line still says which broker or database was meant (#394). Logs get
 * pasted into issues, and in the hosted edition the broker is shared with FinVault.
 * Anything that does not parse as a URL is cut at the credentials by hand rather
 * than printed as given.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.password) return raw;
    url.password = '***';
    return url.toString();
  } catch {
    return raw.replace(/\/\/([^:/@]*):[^@]*@/, '//$1:***@');
  }
}

/**
 * Whether a routine publish or consume of this event is worth a log line (#395).
 * Heartbeats are not: one a second from every service and every node buried
 * everything else in `docker compose logs`, and a missing heartbeat already shows
 * as a status change in the Control Room. Failures are logged for every event.
 */
export function logsTraffic(eventType: string): boolean {
  return !eventType.startsWith('heartbeat.');
}

// ── The connection, kept alive (#448) ────────────────────────────────────────
//
// The connection used to be opened once and cached forever. Nothing listened for
// it closing, so when the broker restarted — a host reboot, `docker compose
// restart`, a broker update — every service kept a dead channel: publishes
// failed from then on, and consumers simply stopped, with nothing in any log.
// Nodes went "offline" and servers stopped changing state until each service was
// restarted by hand. A broker that was slow to come up at boot was as bad: after
// the first attempts the consumers were never set up at all.
//
// Now a lost connection is noticed, reopened with backoff (1 s doubling to 30 s)
// for as long as it takes, and every queue a service consumes is set up again on
// the new channel. A publish while disconnected answers `false` at once instead
// of waiting — the outbox (#167) exists for exactly that.

export interface BrokerDeps {
  connect: (url: string) => Promise<any>;
  url: string | undefined;
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

interface Consumer {
  queueName: string;
  topics: string[];
  onMessage: (envelope: EventEnvelope) => Promise<void>;
}

/** The delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s … capped at 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30_000);
}

export interface BrokerState {
  connected: boolean;
  /** Times the connection was lost and opened again since the process started. */
  reconnects: number;
}

export function createBroker(deps: BrokerDeps) {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => (setTimeout(fn, ms) as unknown as { unref?: () => void }).unref?.());
  const consumers: Consumer[] = [];
  // Which consumers the current channel already serves: one registered while
  // another caller was opening may have missed that open's loop.
  let ready = new Set<Consumer>();
  let connection: any = null;
  let channel: any = null;
  let opening: Promise<{ connection: any; channel: any }> | null = null;
  let reconnectPending = false;
  let attempt = 0;
  let reconnects = 0;
  let everConnected = false;

  async function setUpConsumer(ch: any, c: Consumer): Promise<void> {
    ready.add(c);
    await ch.assertQueue(c.queueName, { durable: true, arguments: { 'x-dead-letter-exchange': DLX } });
    for (const topic of c.topics) await ch.bindQueue(c.queueName, EXCHANGE, topic);
    await ch.prefetch(1);
    await ch.consume(c.queueName, async (msg: any) => {
      if (!msg) return;
      try {
        const envelope = JSON.parse(msg.content.toString()) as EventEnvelope;
        if (logsTraffic(envelope.event.type)) log(`[RabbitMQ Consume] Processing ${envelope.event.type} from queue ${c.queueName}`);
        await c.onMessage(envelope);
        ch.ack(msg);
      } catch (error: any) {
        warn(`[RabbitMQ Consume] Error processing message in queue ${c.queueName}: ${error?.message}`);
        // Reject with no-requeue to trigger dead-lettering
        ch.nack(msg, false, false);
      }
    });
  }

  function lost(conn: any, why: string) {
    if (connection !== conn) return; // an old connection's last words
    connection = null;
    channel = null;
    warn(`[RabbitMQ] Connection lost (${why}); reconnecting.`);
    try {
      conn.close?.().catch?.(() => undefined);
    } catch {
      // already closed
    }
    scheduleReconnect();
  }

  async function openOnce(): Promise<{ connection: any; channel: any }> {
    const conn = await deps.connect(deps.url!);
    try {
      const ch = await conn.createChannel();
      // Dead-letter exchange + queue (shared with FinVault)
      await ch.assertExchange(DLX, 'fanout', { durable: true });
      await ch.assertQueue(DLQ, { durable: true });
      await ch.bindQueue(DLQ, DLX, '');
      // Primary topic exchange (shared with FinVault)
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      ready = new Set();
      for (const c of consumers) await setUpConsumer(ch, c);

      // An 'error' with no listener would end the process; a 'close' with none
      // used to leave it running deaf. Either way: reopen.
      conn.on?.('error', (err: any) => warn(`[RabbitMQ] Connection error: ${err?.message ?? err}`));
      conn.on?.('close', () => lost(conn, 'connection closed'));
      ch.on?.('error', (err: any) => warn(`[RabbitMQ] Channel error: ${err?.message ?? err}`));
      ch.on?.('close', () => lost(conn, 'channel closed'));

      connection = conn;
      channel = ch;
      if (everConnected) reconnects++;
      everConnected = true;
      attempt = 0;
      log(`[RabbitMQ] Connected${consumers.length ? `, consuming ${consumers.map((c) => c.queueName).join(', ')}` : ''}.`);
      return { connection, channel };
    } catch (err) {
      await Promise.resolve(conn.close?.()).catch(() => undefined);
      throw err;
    }
  }

  /** One opening at a time: concurrent callers share it. */
  function open(): Promise<{ connection: any; channel: any }> {
    if (!opening) opening = openOnce().finally(() => (opening = null));
    return opening;
  }

  function scheduleReconnect() {
    if (reconnectPending || !deps.url) return;
    reconnectPending = true;
    const delay = reconnectDelayMs(attempt++);
    setTimer(() => {
      reconnectPending = false;
      if (channel) return;
      open().catch((err) => {
        warn(`[RabbitMQ] Reconnect failed: ${err?.message ?? err}; next try in ${reconnectDelayMs(attempt) / 1000} s.`);
        scheduleReconnect();
      });
    }, delay);
  }

  return {
    async connect(retryCount = 8, delayMs = 3000): Promise<{ connection: any; channel: any }> {
      if (connection && channel) return { connection, channel };
      if (!deps.url) {
        warn('[RabbitMQ] RABBITMQ_URL not set — skipping connection (async events disabled). Set RABBITMQ_URL to enable.');
        throw new Error('RABBITMQ_URL not configured');
      }
      for (let i = 1; i <= retryCount; i++) {
        try {
          log(`[RabbitMQ] Connecting to ${redactUrl(deps.url)} (Attempt ${i}/${retryCount})...`);
          return await open();
        } catch (error: any) {
          warn(`[RabbitMQ] Connection attempt ${i} failed: ${error?.message}`);
          if (i === retryCount) throw error;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      throw new Error('Could not connect to RabbitMQ');
    },

    async publish(routingKey: string, envelope: EventEnvelope): Promise<boolean> {
      try {
        // Disconnected: one quick try, never the start-up retry loop — a caller
        // waiting on a publish is an HTTP request waiting, and the outbox retries.
        const ch = channel ?? (reconnectPending || opening ? null : (await this.connect(1, 0)).channel);
        if (!ch) {
          warn(`[RabbitMQ Publish] Not connected; ${envelope.event.type} was not sent.`);
          return false;
        }
        const success = ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(envelope)), { persistent: true });
        if (success) {
          if (logsTraffic(envelope.event.type)) log(`[RabbitMQ Publish] Published ${envelope.event.type} with key: ${routingKey}`);
          return true;
        }
        warn('[RabbitMQ Publish] Write buffer full, publish returned false.');
        return false;
      } catch (error: any) {
        warn(`[RabbitMQ Publish] Failed to publish event: ${error?.message}`);
        if (deps.url && !channel) scheduleReconnect();
        return false;
      }
    },

    /**
     * Consume `queueName`, now and after every reconnect. When the broker cannot
     * be reached at start the consumer is kept and set up once it can — it used
     * to be dropped for good after the first attempts.
     */
    async consume(queueName: string, topics: string[], onMessage: (envelope: EventEnvelope) => Promise<void>): Promise<void> {
      const consumer: Consumer = { queueName, topics, onMessage };
      consumers.push(consumer);
      if (!deps.url) {
        consumers.pop();
        await this.connect(); // throws: not configured
        return;
      }
      if (channel) {
        await setUpConsumer(channel, consumer);
      } else {
        try {
          // A fresh open sets up every registered consumer, this one included.
          // One try: from here the backoff keeps trying for as long as it takes.
          const { channel: ch } = await this.connect(1, 0);
          if (!ready.has(consumer)) await setUpConsumer(ch, consumer);
        } catch (error: any) {
          warn(`[RabbitMQ Consume] Broker not reachable yet (${error?.message}); ${queueName} will be consumed once it is.`);
          scheduleReconnect();
          return;
        }
      }
      for (const topic of topics) log(`[RabbitMQ Consume] Bound queue ${queueName} to topic: ${topic}`);
      log(`[RabbitMQ Consume] Started consuming from queue: ${queueName}`);
    },

    /** The live channel, or null while disconnected. Hold it only for one call. */
    currentChannel(): any {
      return channel;
    },

    state(): BrokerState {
      return { connected: Boolean(channel), reconnects };
    },
  };
}

const broker = createBroker({ connect: (url) => amqp.connect(url), url: RABBITMQ_URL ? RABBITMQ_URL_WITH_DEFAULT : undefined });

export function connectRabbitMQ(retryCount = 8, delayMs = 3000): Promise<{ connection: any; channel: any }> {
  return broker.connect(retryCount, delayMs);
}

export function publishRabbitEvent(routingKey: string, envelope: EventEnvelope): Promise<boolean> {
  return broker.publish(routingKey, envelope);
}

export function consumeRabbitQueue(queueName: string, topics: string[], onMessage: (envelope: EventEnvelope) => Promise<void>): Promise<void> {
  return broker.consume(queueName, topics, onMessage);
}

/** The live channel, or null while reconnecting (#448) — for passive checks like the DLQ depth. */
export function currentRabbitChannel(): any {
  return broker.currentChannel();
}

/** Whether this process is connected to the broker, and how often it had to reconnect (#448). */
export function rabbitState(): BrokerState {
  return broker.state();
}
