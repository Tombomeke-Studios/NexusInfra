import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import {
  decodeFrame,
  encodeFrame,
  FRAME_DATA,
  FRAME_END,
  FRAME_OPEN,
  FRAME_RESET,
  keepLinkAlive,
  LinkSession,
  resetFrame,
  type LinkSocket,
  type LinkStream,
} from './agentLink.js';

/** Two sessions joined by fake sockets that deliver on the next tick. */
function pair(onOpen?: (s: LinkStream) => void) {
  const sent = { a: [] as Buffer[], b: [] as Buffer[] };
  const socketA: LinkSocket & { buffered: number } = {
    buffered: 0,
    get bufferedAmount() {
      return this.buffered;
    },
    send(data, cb) {
      sent.a.push(data);
      setImmediate(() => {
        b.receive(data);
        cb?.();
      });
    },
  };
  const socketB: LinkSocket = {
    bufferedAmount: 0,
    send(data, cb) {
      sent.b.push(data);
      setImmediate(() => {
        a.receive(data);
        cb?.();
      });
    },
  };
  const a = new LinkSession(socketA);
  const b = new LinkSession(socketB, { onOpen });
  return { a, b, socketA, sent };
}

async function readAll(stream: LinkStream): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  await once(stream, 'end');
  return Buffer.concat(chunks).toString();
}

describe('frames', () => {
  it('lays a frame out as type, big-endian stream id, payload', () => {
    const frame = encodeFrame(FRAME_DATA, 0x01020304, Buffer.from('hi'));
    expect([...frame]).toEqual([2, 1, 2, 3, 4, 0x68, 0x69]);
    expect(decodeFrame(frame)).toEqual({ type: FRAME_DATA, streamId: 0x01020304, payload: Buffer.from('hi') });
  });

  it('keeps the contract numbers', () => {
    expect([FRAME_OPEN, FRAME_DATA, FRAME_END, FRAME_RESET]).toEqual([1, 2, 3, 4]);
  });

  it('refuses what is not a frame', () => {
    expect(decodeFrame(Buffer.from([2, 0, 0]))).toBeNull();
    expect(decodeFrame(Buffer.from([9, 0, 0, 0, 1]))).toBeNull();
  });

  it('carries a reset reason as UTF-8, bounded', () => {
    const frame = decodeFrame(resetFrame(7, 'x'.repeat(1000)))!;
    expect(frame.type).toBe(FRAME_RESET);
    expect(frame.payload.length).toBe(200);
  });
});

describe('LinkSession', () => {
  it('opens a stream the peer answers, both ways, with half-close', async () => {
    const { a } = pair((s) => {
      // An echo that upper-cases and ends when the request does.
      s.on('data', (c: Buffer) => s.write(c.toString().toUpperCase()));
      s.on('end', () => s.end());
    });
    const stream = a.open();
    const closed = once(stream, 'close');
    stream.end('hello link');
    expect(await readAll(stream)).toBe('HELLO LINK');
    await closed;
    expect(a.size).toBe(0);
  });

  it('carries binary bytes unchanged', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const { a } = pair((s) => s.end(bytes));
    const stream = a.open();
    stream.end();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    await once(stream, 'end');
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  });

  it('gives every stream its own id', () => {
    const { a } = pair(() => undefined);
    expect(new Set([a.open().streamId, a.open().streamId, a.open().streamId]).size).toBe(3);
  });

  it('refuses an OPEN on the side that only opens', async () => {
    const { a, sent } = pair();
    a.receive(encodeFrame(FRAME_OPEN, 42));
    await new Promise((r) => setImmediate(r));
    const answer = decodeFrame(sent.a.at(-1)!)!;
    expect(answer).toMatchObject({ type: FRAME_RESET, streamId: 42 });
  });

  it('fails the stream with the peer’s reason on a RESET', async () => {
    const { a } = pair((s) => s.destroy(new Error('connect ECONNREFUSED')));
    const stream = a.open();
    const [err] = await once(stream, 'error');
    expect((err as Error).message).toBe('connect ECONNREFUSED');
  });

  it('fails every open stream when the link closes', async () => {
    const { a } = pair(() => undefined);
    const one = a.open();
    const two = a.open();
    const errors = Promise.all([once(one, 'error'), once(two, 'error')]);
    a.close('replaced by a new link');
    const [[e1], [e2]] = await errors;
    expect((e1 as Error).message).toBe('replaced by a new link');
    expect((e2 as Error).message).toBe('replaced by a new link');
    expect(() => a.open()).toThrow(/closed/);
  });

  it('answers a frame for a stream nobody knows with a RESET, and a RESET with nothing', async () => {
    const { a, sent } = pair();
    a.receive(encodeFrame(FRAME_DATA, 9, Buffer.from('?')));
    a.receive(resetFrame(10, 'gone'));
    await new Promise((r) => setImmediate(r));
    expect(sent.a.map((f) => decodeFrame(f)!.streamId)).toEqual([9]);
  });

  it('holds a writer while the socket is above the high-water mark', async () => {
    const { a, socketA } = pair(() => undefined);
    const stream = a.open();
    socketA.buffered = 2 * 1024 * 1024;
    let written = false;
    stream.write(Buffer.alloc(10), () => {
      written = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(written).toBe(false);
    socketA.buffered = 0;
    await new Promise((r) => setTimeout(r, 30));
    expect(written).toBe(true);
  });
});

describe('keepLinkAlive', () => {
  it('pings, and terminates a socket that went silent', () => {
    vi.useFakeTimers();
    let clock = 0;
    const handlers: Record<string, () => void> = {};
    const socket = {
      ping: vi.fn(),
      terminate: vi.fn(),
      on: (event: string, cb: () => void) => {
        handlers[event] = cb;
      },
    };
    keepLinkAlive(socket, { pingMs: 15, idleMs: 45, now: () => clock });
    for (let i = 0; i < 2; i++) {
      clock += 15;
      vi.advanceTimersByTime(15);
    }
    expect(socket.ping).toHaveBeenCalledTimes(2);
    handlers.pong();
    clock += 30;
    vi.advanceTimersByTime(30);
    expect(socket.terminate).not.toHaveBeenCalled();
    clock += 45;
    vi.advanceTimersByTime(45);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
