import { describe, it, expect, beforeEach } from 'vitest';
import { pipeSockets, toWsUrl, type DuplexSocket } from './wsProxy.js';

class FakeSocket implements DuplexSocket {
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
  emitMessage(d: string) {
    this.handlers.message.forEach((cb) => (cb as (x: string) => void)(d));
  }
  emitClose() {
    this.handlers.close.forEach((cb) => (cb as () => void)());
  }
}

describe('toWsUrl', () => {
  it('maps http→ws and https→wss', () => {
    expect(toWsUrl('http://node-agent:9100')).toBe('ws://node-agent:9100');
    expect(toWsUrl('https://node-agent:9100')).toBe('wss://node-agent:9100');
  });
});

describe('pipeSockets', () => {
  let client: FakeSocket;
  let upstream: FakeSocket;
  beforeEach(() => {
    client = new FakeSocket();
    upstream = new FakeSocket();
    pipeSockets(client, upstream);
  });

  it('forwards client messages to upstream and vice versa', () => {
    client.emitMessage('ls\n');
    expect(upstream.sent).toEqual(['ls\n']);
    upstream.emitMessage('output');
    expect(client.sent).toEqual(['output']);
  });

  it('closing one side closes the other', () => {
    client.emitClose();
    expect(upstream.closed).toBe(true);
  });

  it('closing upstream closes the client', () => {
    upstream.emitClose();
    expect(client.closed).toBe(true);
  });
});
