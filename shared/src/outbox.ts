import type { EventEnvelope } from './events.js';
// Reuse the existing publisher signature rather than declaring an identical one.
import type { PublishFn } from './heartbeat.js';

// Publish outbox (#167). `publishRabbitEvent` returns false when the broker is
// unreachable, and the event is then gone — which silently corrupts state that is
// derived from events (a lost `server.stopped` leaves a deployment "running"
// forever). This wraps any publisher so a failed publish is *held* and replayed
// when the broker comes back.
//
// RabbitMQ's durable queues only protect a message once it has been accepted;
// they do nothing for a publish that never landed. This closes that gap.
//
// Deliberately in-memory: it survives a broker blip, not a process restart. A
// disk-backed outbox is a bigger change (and belongs with the Postgres work).

export interface QueuedEvent {
  routingKey: string;
  envelope: EventEnvelope;
  /** When the event was first queued (epoch ms) — useful for logging staleness. */
  enqueuedAt: number;
}

export interface OutboxOptions {
  /** Max events held during an outage. Past this the oldest are dropped. */
  capacity?: number;
  /** Called when an event is evicted, so the loss is visible rather than silent. */
  onDrop?: (event: QueuedEvent) => void;
}

const DEFAULT_CAPACITY = 500;

export class PublishOutbox {
  private queue: QueuedEvent[] = [];
  private dropped = 0;
  private flushing = false;
  private readonly capacity: number;
  private readonly onDrop?: (event: QueuedEvent) => void;

  constructor(
    private readonly publisher: PublishFn,
    options: OutboxOptions = {}
  ) {
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
    this.onDrop = options.onDrop;
  }

  /** Events currently held awaiting delivery. */
  get pending(): number {
    return this.queue.length;
  }

  /** Events discarded because the outbox was full — real, reported data loss. */
  get droppedCount(): number {
    return this.dropped;
  }

  /**
   * Publish an event. Any backlog is drained first so ordering is preserved, then
   * this event is sent. Returns whether *this* event was delivered; on failure it
   * is queued for replay rather than dropped.
   */
  async publish(routingKey: string, envelope: EventEnvelope): Promise<boolean> {
    // Drain first: a newer event must never overtake an older queued one.
    if (this.queue.length > 0) {
      await this.flush();
      if (this.queue.length > 0) {
        // Still down — this event goes behind the backlog.
        this.enqueue({ routingKey, envelope, enqueuedAt: Date.now() });
        return false;
      }
    }

    if (await this.attempt(routingKey, envelope)) return true;
    this.enqueue({ routingKey, envelope, enqueuedAt: Date.now() });
    return false;
  }

  /**
   * Try to deliver the backlog, oldest first. Stops at the first failure so the
   * remaining events keep their order. Returns how many were delivered.
   */
  async flush(): Promise<number> {
    // Guard against re-entrancy (the periodic flusher overlapping a publish).
    if (this.flushing) return 0;
    this.flushing = true;
    let delivered = 0;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        if (!(await this.attempt(next.routingKey, next.envelope))) break;
        this.queue.shift();
        delivered += 1;
      }
    } finally {
      this.flushing = false;
    }
    return delivered;
  }

  /** Deliver one event, treating a thrown error the same as a `false` return. */
  private async attempt(routingKey: string, envelope: EventEnvelope): Promise<boolean> {
    try {
      return await this.publisher(routingKey, envelope);
    } catch {
      return false;
    }
  }

  /** Queue an event, evicting the oldest if we are at capacity. */
  private enqueue(event: QueuedEvent): void {
    if (this.queue.length >= this.capacity) {
      const evicted = this.queue.shift();
      this.dropped += 1;
      if (evicted) this.onDrop?.(evicted);
    }
    this.queue.push(event);
  }
}

/**
 * Periodically drain an outbox, so a backlog recovers even when nothing new is
 * being published. Returns a stop function.
 */
export function startOutboxFlusher(outbox: PublishOutbox, intervalMs = 5000): () => void {
  const handle = setInterval(() => void outbox.flush(), intervalMs);
  // Don't hold the process open just for retries.
  handle.unref?.();
  return () => clearInterval(handle);
}
