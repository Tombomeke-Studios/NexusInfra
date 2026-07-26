import { describe, it, expect, beforeEach } from 'vitest';
import { attachTerminal, type TerminalSession, type TerminalSocket } from './terminal.js';

// Fakes for the two edges so the bridge logic is tested without ws/dockerode.
class FakeSocket implements TerminalSocket {
  private handlers: Record<string, ((arg: never) => void)[]> = { message: [], close: [] };
  sent: string[] = [];
  closed = false;
  on(event: 'message' | 'close', cb: never) {
    this.handlers[event].push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emitMessage(raw: string) {
    this.handlers.message.forEach((cb) => (cb as (d: string) => void)(raw));
  }
  emitClose() {
    this.handlers.close.forEach((cb) => (cb as () => void)());
  }
}

class FakeSession implements TerminalSession {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  closed = false;
  private dataCb?: (d: string) => void;
  private exitCb?: () => void;
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: () => void) {
    this.exitCb = cb;
  }
  close() {
    this.closed = true;
  }
  emitData(d: string) {
    this.dataCb?.(d);
  }
  emitExit() {
    this.exitCb?.();
  }
}

describe('attachTerminal', () => {
  let socket: FakeSocket;
  let session: FakeSession;
  beforeEach(() => {
    socket = new FakeSocket();
    session = new FakeSession();
    attachTerminal(socket, session);
  });

  it('streams shell output to the socket', () => {
    session.emitData('hello\r\n');
    expect(socket.sent).toEqual(['hello\r\n']);
  });

  it('writes client input to the shell', () => {
    socket.emitMessage(JSON.stringify({ type: 'input', data: 'ls\n' }));
    expect(session.writes).toEqual(['ls\n']);
  });

  it('resizes the pty on a resize message', () => {
    socket.emitMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(session.resizes).toEqual([[120, 40]]);
  });

  it('ignores malformed frames', () => {
    socket.emitMessage('not json');
    socket.emitMessage(JSON.stringify({ type: 'bogus' }));
    expect(session.writes).toEqual([]);
    expect(session.resizes).toEqual([]);
  });

  it('closes the socket when the session exits', () => {
    session.emitExit();
    expect(socket.closed).toBe(true);
  });

  it('closes the session when the socket closes', () => {
    socket.emitClose();
    expect(session.closed).toBe(true);
  });
});
