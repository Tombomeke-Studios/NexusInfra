// Watching the dead-letter queue (#243).
//
// Consumers `nack` without requeue when they fail, so a message that cannot be
// processed lands in `finvault.events.dlq`. Nothing read that queue and nothing
// reported on it — events could be dropped silently and indefinitely, and the
// only way to find out was to open the RabbitMQ management UI and think to look.
//
// The Control Room already answers "is everything alive"; this is the same
// question about the messages rather than the services.
//
// Pure: the broker probe is injected, so the states below are tested without one.

/** The queue the broker dead-letters to, matching FinVault's topology. */
export const DLQ_NAME = 'finvault.events.dlq';

export type DlqStatus =
  /** Nothing has failed. */
  | 'empty'
  /** Messages are waiting, which always means something needs looking at. */
  | 'messages-waiting'
  /** The broker could not be asked — not the same as "nothing is wrong". */
  | 'unknown';

export interface DlqSnapshot {
  status: DlqStatus;
  /** How many messages are sitting in the queue; null when it could not be asked. */
  depth: number | null;
  /** Why the depth is unknown, when it is. */
  error?: string;
}

/** What a channel has to offer for this to work — one method, so tests need no broker. */
export interface QueueProbe {
  checkQueue(name: string): Promise<{ messageCount: number }>;
}

/**
 * Read the dead-letter queue's depth.
 *
 * `checkQueue` is passive: it reports the depth without consuming anything, which
 * matters because these messages are evidence. Reading them properly would mean
 * consuming and requeueing, which mutates their redelivery state — so the age of
 * the oldest message is deliberately not reported here rather than disturbed to
 * find out. Depth alone answers the question that matters: is anything stuck.
 */
export async function readDlq(probe: QueueProbe | null, name: string = DLQ_NAME): Promise<DlqSnapshot> {
  if (!probe) {
    return { status: 'unknown', depth: null, error: 'not connected to the broker' };
  }
  try {
    const { messageCount } = await probe.checkQueue(name);
    return { status: messageCount > 0 ? 'messages-waiting' : 'empty', depth: messageCount };
  } catch (err) {
    // A missing queue, a closed channel, an unreachable broker — all report as
    // unknown. Reporting 0 would say "nothing has failed", which is a different
    // claim entirely and the one nobody should make on this evidence.
    return { status: 'unknown', depth: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A sentence for the panel to show.
 *
 * Spelled out rather than left as a number, because "3" next to a queue name means
 * nothing to somebody who has never had to think about dead-lettering.
 */
export function describeDlq(snapshot: DlqSnapshot): string {
  switch (snapshot.status) {
    case 'empty':
      return 'No failed events.';
    case 'messages-waiting':
      return snapshot.depth === 1
        ? '1 event could not be processed and is waiting in the dead-letter queue.'
        : `${snapshot.depth} events could not be processed and are waiting in the dead-letter queue.`;
    case 'unknown':
      return 'The dead-letter queue could not be read, so whether anything failed is unknown.';
  }
}
