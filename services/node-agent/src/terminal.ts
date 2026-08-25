// Interactive terminal bridge (#71/#69). Connects a WebSocket-like client to an
// interactive exec session (a shell running in the container with a TTY). Kept
// pure — it depends only on the two small interfaces below, not on `ws` or
// dockerode — so the bridging logic is unit-testable with fakes; the real socket
// and Docker exec are wired in at the edges (index.ts / runtime.ts).

/** A bidirectional exec session (a TTY shell in the container). */
export interface TerminalSession {
  /** Send keystrokes to the shell's stdin. */
  write(data: string): void;
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): void;
  /** Register a handler for terminal output. */
  onData(cb: (data: string) => void): void;
  /** Register a handler for when the session ends. */
  onExit(cb: () => void): void;
  /** Tear the session down. */
  close(): void;
}

/** The minimal WebSocket surface the bridge needs. */
export interface TerminalSocket {
  on(event: 'message', cb: (data: string) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

// Client → server messages are JSON so keystrokes and control (resize) are
// unambiguous; server → client is raw terminal output.
type ClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (msg && msg.type === 'input' && typeof msg.data === 'string') return msg;
    if (msg && msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') return msg;
    return null;
  } catch {
    return null;
  }
}

/**
 * Bridge a client socket to a terminal session: client input/resize drives the
 * shell; shell output streams back; either side closing tears down the other.
 */
export function attachTerminal(socket: TerminalSocket, session: TerminalSession): void {
  session.onData((data) => socket.send(data));
  session.onExit(() => socket.close());

  socket.on('message', (raw) => {
    const msg = parseClientMessage(raw);
    if (!msg) return; // ignore malformed frames
    if (msg.type === 'input') session.write(msg.data);
    else session.resize(msg.cols, msg.rows);
  });

  socket.on('close', () => session.close());
}
