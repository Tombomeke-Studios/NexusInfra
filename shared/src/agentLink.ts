import { Duplex } from 'node:stream';

// The agent link (#416): one WebSocket a node agent opens to the control plane,
// so a node behind NAT — with no address anybody can call — can still be
// controlled. The orchestrator's calls to that agent come back over it.
//
// The link carries byte streams, not API calls. HTTP, server-sent events and the
// terminal's own WebSocket all ride on it unchanged: the orchestrator writes an
// ordinary HTTP request into a stream, the agent pipes the stream into its own
// HTTP server on loopback. Neither side needs to know what the bytes mean.
//
// Every frame is one binary WebSocket message:
//
//   [type: u8][streamId: u32 big-endian][payload]
//
// The design is shared with NexusFleet (docs/agent-link.md there) — the numbers
// and names below are a contract, not a choice to revisit here.

export const FRAME_OPEN = 1;
export const FRAME_DATA = 2;
export const FRAME_END = 3;
export const FRAME_RESET = 4;

export type FrameType = typeof FRAME_OPEN | typeof FRAME_DATA | typeof FRAME_END | typeof FRAME_RESET;

/** The handshake header that names which node is dialling. */
export const LINK_NODE_HEADER = 'x-nexus-node-id';
/** The path the gateway routes to the orchestrator for a link. */
export const LINK_PATH = '/agent-link';
/** A sender stops reading its source while this much is waiting on the WebSocket. */
export const LINK_HIGH_WATER_BYTES = 1024 * 1024;
/** Both sides ping this often… */
export const LINK_PING_MS = 15_000;
/** …and drop a link that said nothing for this long. */
export const LINK_IDLE_MS = 45_000;

const HEADER_BYTES = 5;
// A reason is diagnostic, not a channel: long enough to say what failed.
const MAX_REASON_BYTES = 200;

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}

export function encodeFrame(type: FrameType, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(streamId >>> 0, 1);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

/** A frame, or null for anything that is not one — a peer's garbage is not a crash. */
export function decodeFrame(data: Buffer): Frame | null {
  if (data.length < HEADER_BYTES) return null;
  const type = data.readUInt8(0);
  if (type !== FRAME_OPEN && type !== FRAME_DATA && type !== FRAME_END && type !== FRAME_RESET) return null;
  return { type, streamId: data.readUInt32BE(1), payload: data.subarray(HEADER_BYTES) };
}

export function resetFrame(streamId: number, reason: string): Buffer {
  let payload = Buffer.from(reason, 'utf8');
  if (payload.length > MAX_REASON_BYTES) payload = payload.subarray(0, MAX_REASON_BYTES);
  return encodeFrame(FRAME_RESET, streamId, payload);
}

/** The part of a `ws` WebSocket a session needs — small enough to fake in a test. */
export interface LinkSocket {
  send(data: Buffer, cb?: (err?: Error) => void): void;
  readonly bufferedAmount: number;
}

export interface LinkSessionOptions {
  /**
   * Called for every OPEN the peer sends. Only the agent side passes this: the
   * orchestrator opens streams and never accepts one, so an OPEN sent to it is
   * refused.
   */
  onOpen?: (stream: LinkStream) => void;
  highWaterBytes?: number;
}

/**
 * One end of a link: the streams multiplexed over one WebSocket. Feed it every
 * binary message with `receive`, and `close` it when the socket goes.
 */
export class LinkSession {
  private readonly streams = new Map<number, LinkStream>();
  private nextId = 1;
  private closed = false;
  readonly highWaterBytes: number;

  constructor(
    private readonly socket: LinkSocket,
    private readonly options: LinkSessionOptions = {}
  ) {
    this.highWaterBytes = options.highWaterBytes ?? LINK_HIGH_WATER_BYTES;
  }

  /** How many streams are open right now. */
  get size(): number {
    return this.streams.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Open a stream to the peer (the orchestrator's side). */
  open(): LinkStream {
    if (this.closed) throw new Error('the agent link is closed');
    const id = this.allocateId();
    const stream = new LinkStream(this, id);
    this.streams.set(id, stream);
    this.send(encodeFrame(FRAME_OPEN, id));
    return stream;
  }

  /** One binary message from the peer. */
  receive(data: Buffer): void {
    if (this.closed) return;
    const frame = decodeFrame(data);
    if (!frame) return;
    const stream = this.streams.get(frame.streamId);

    if (frame.type === FRAME_OPEN) {
      if (stream || !this.options.onOpen) return this.send(resetFrame(frame.streamId, 'stream refused'));
      const opened = new LinkStream(this, frame.streamId);
      this.streams.set(frame.streamId, opened);
      this.options.onOpen(opened);
      return;
    }
    // A stream either side already forgot. A RESET for it needs no answer — that
    // is how two RESETs crossing each other end, instead of bouncing for ever.
    if (!stream) {
      if (frame.type !== FRAME_RESET) this.send(resetFrame(frame.streamId, 'unknown stream'));
      return;
    }
    if (frame.type === FRAME_DATA) stream.remoteData(frame.payload);
    else if (frame.type === FRAME_END) stream.remoteEnd();
    else stream.remoteReset(frame.payload.toString('utf8') || 'reset by peer');
  }

  /** The socket is gone: every stream on it fails. */
  close(reason = 'agent link closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) stream.remoteReset(reason);
    this.streams.clear();
  }

  /** @internal */
  send(frame: Buffer, cb?: () => void): void {
    if (this.closed) return cb?.();
    this.socket.send(frame, () => cb?.());
  }

  /** @internal — calls `cb` once the socket has room again (the 1 MiB rule). */
  whenDrained(cb: () => void): void {
    if (this.closed || this.socket.bufferedAmount <= this.highWaterBytes) return cb();
    setTimeout(() => this.whenDrained(cb), 5);
  }

  /** @internal */
  forget(id: number): void {
    this.streams.delete(id);
  }

  private allocateId(): number {
    // u32 ids, never 0; one that wraps round onto a stream still open skips it.
    for (;;) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
      if (!this.streams.has(id)) return id;
    }
  }
}

/**
 * One stream on a link, as a Node.js `Duplex`: what you write reaches the peer's
 * end, what the peer writes you read. Carries the few socket methods HTTP
 * clients call on a connection (`ref`, `setNoDelay`, …) as no-ops, so undici and
 * `http.request` take it where they expect a TCP socket.
 */
export class LinkStream extends Duplex {
  private remoteEnded = false;
  private localEnded = false;
  private wasReset = false;

  constructor(
    private readonly session: LinkSession,
    readonly streamId: number
  ) {
    super({ allowHalfOpen: true });
    // A link that drops fails every stream on it. Whoever uses a stream listens
    // for that; one nobody is reading yet must not take the process down with it.
    this.on('error', () => undefined);
  }

  /** @internal */
  remoteData(payload: Buffer): void {
    if (!this.remoteEnded) this.push(payload);
  }

  /** @internal */
  remoteEnd(): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    this.push(null);
    this.settle();
  }

  /** @internal */
  remoteReset(reason: string): void {
    if (this.wasReset) return;
    this.wasReset = true;
    this.session.forget(this.streamId);
    this.destroy(new Error(reason));
  }

  override _read(): void {
    // Data is pushed as frames arrive.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.wasReset) return cb(new Error('stream reset'));
    this.session.send(encodeFrame(FRAME_DATA, this.streamId, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    // Holding the callback is the backpressure: a pipe into this stream stops
    // reading its source until the WebSocket has drained below the mark.
    this.session.whenDrained(() => cb());
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.localEnded = true;
    if (!this.wasReset) this.session.send(encodeFrame(FRAME_END, this.streamId));
    this.settle();
    cb();
  }

  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    // Torn down before both sides finished: the peer must not wait for more.
    if (!this.wasReset && !(this.localEnded && this.remoteEnded)) {
      this.wasReset = true;
      this.session.send(resetFrame(this.streamId, err?.message || 'stream closed'));
    }
    this.session.forget(this.streamId);
    cb(err);
  }

  private settle(): void {
    if (this.localEnded && this.remoteEnded) this.session.forget(this.streamId);
  }

  // Socket look-alikes for HTTP clients.
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setTimeout(): this {
    return this;
  }
}

/** The part of a `ws` WebSocket the keep-alive needs. */
export interface PingableSocket {
  ping(): void;
  terminate(): void;
  on(event: 'pong' | 'message' | 'ping', cb: () => void): unknown;
}

/**
 * Ping every `pingMs`; terminate a socket that said nothing — no pong, no ping,
 * no message — for `idleMs`. Returns a stop function. Both ends run this, so a
 * link through a NAT that silently dropped its mapping is noticed on both.
 */
export function keepLinkAlive(
  socket: PingableSocket,
  options: { pingMs?: number; idleMs?: number; now?: () => number } = {}
): () => void {
  const pingMs = options.pingMs ?? LINK_PING_MS;
  const idleMs = options.idleMs ?? LINK_IDLE_MS;
  const now = options.now ?? Date.now;
  let lastHeard = now();
  const heard = () => {
    lastHeard = now();
  };
  socket.on('pong', heard);
  socket.on('ping', heard);
  socket.on('message', heard);
  const timer = setInterval(() => {
    if (now() - lastHeard >= idleMs) {
      clearInterval(timer);
      socket.terminate();
      return;
    }
    try {
      socket.ping();
    } catch {
      // A socket that cannot be pinged is closing; the close handler cleans up.
    }
  }, pingMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
