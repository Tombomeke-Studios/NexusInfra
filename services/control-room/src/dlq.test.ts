import { describe, it, expect } from 'vitest';
import { readDlq, describeDlq, DLQ_NAME } from './dlq.js';

// Consumers nack without requeue on failure, so messages land in the DLQ — where
// nothing read them and nothing reported on them (#243).

describe('readDlq', () => {
  it('reports an empty queue as nothing having failed', async () => {
    const snapshot = await readDlq({ checkQueue: async () => ({ messageCount: 0 }) });
    expect(snapshot).toEqual({ status: 'empty', depth: 0 });
  });

  it('reports waiting messages with their count', async () => {
    const snapshot = await readDlq({ checkQueue: async () => ({ messageCount: 3 }) });
    expect(snapshot).toEqual({ status: 'messages-waiting', depth: 3 });
  });

  it('asks about the dead-letter queue by default', async () => {
    const asked: string[] = [];
    await readDlq({
      checkQueue: async (name) => {
        asked.push(name);
        return { messageCount: 0 };
      },
    });
    expect(asked).toEqual([DLQ_NAME]);
  });

  // The distinction the whole module turns on: not knowing is not the same as
  // knowing nothing failed, and reporting 0 would make the stronger claim.
  it('reports unknown rather than zero when the broker cannot be asked', async () => {
    const snapshot = await readDlq(null);
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.depth).toBeNull();
  });

  it('reports unknown when the probe throws, keeping the reason', async () => {
    const snapshot = await readDlq({
      checkQueue: async () => {
        throw new Error('channel closed');
      },
    });
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.depth).toBeNull();
    expect(snapshot.error).toBe('channel closed');
  });
});

describe('describeDlq', () => {
  it('says plainly that nothing failed', () => {
    expect(describeDlq({ status: 'empty', depth: 0 })).toBe('No failed events.');
  });

  it('explains what a waiting message means, rather than showing a bare number', () => {
    // "3" next to a queue name means nothing to somebody who has never had to
    // think about dead-lettering.
    expect(describeDlq({ status: 'messages-waiting', depth: 3 })).toMatch(/3 events could not be processed/);
  });

  it('counts one message in the singular', () => {
    expect(describeDlq({ status: 'messages-waiting', depth: 1 })).toMatch(/^1 event could not be processed/);
  });

  it('does not claim health when the queue could not be read', () => {
    expect(describeDlq({ status: 'unknown', depth: null })).toMatch(/could not be read/);
  });
});
