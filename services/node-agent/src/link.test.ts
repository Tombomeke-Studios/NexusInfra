import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { LinkSession } from 'shared';
import { linkConfigFromEnv, linkUrlProblem, nextRetryMs, startAgentLink, type AgentLink } from './link.js';

describe('linkUrlProblem', () => {
  it('takes wss:// anywhere', () => {
    expect(linkUrlProblem('wss://nexus.example.com/agent-link', false)).toBeNull();
  });

  it('takes ws:// only on loopback, or when a lab opts in', () => {
    expect(linkUrlProblem('ws://127.0.0.1:9400/agent-link', false)).toBeNull();
    expect(linkUrlProblem('ws://localhost:9400/agent-link', false)).toBeNull();
    expect(linkUrlProblem('ws://[::1]:9400/agent-link', false)).toBeNull();
    expect(linkUrlProblem('ws://192.168.1.10:9400/agent-link', false)).toMatch(/wss/);
    expect(linkUrlProblem('ws://192.168.1.10:9400/agent-link', true)).toBeNull();
  });

  it('refuses anything that is not a WebSocket URL', () => {
    expect(linkUrlProblem('https://nexus.example.com/agent-link', true)).toMatch(/wss/);
    expect(linkUrlProblem('not a url', true)).toMatch(/not a URL/);
  });
});

describe('linkConfigFromEnv', () => {
  it('is off without a link URL — a direct agent, as before', () => {
    expect(linkConfigFromEnv({})).toBeNull();
  });

  it('needs a token with a URL', () => {
    expect(linkConfigFromEnv({ AGENT_LINK_URL: 'wss://x/agent-link' })).toEqual({ problem: expect.stringMatching(/AGENT_LINK_TOKEN/) });
    expect(linkConfigFromEnv({ AGENT_LINK_URL: 'wss://x/agent-link', AGENT_LINK_TOKEN: 't' })).toEqual({ url: 'wss://x/agent-link', token: 't' });
  });

  it('reads the insecure opt-in only as the word true', () => {
    expect(linkConfigFromEnv({ AGENT_LINK_URL: 'ws://10.0.0.1/agent-link', AGENT_LINK_TOKEN: 't', AGENT_LINK_ALLOW_INSECURE: '1' })).toHaveProperty('problem');
    expect(linkConfigFromEnv({ AGENT_LINK_URL: 'ws://10.0.0.1/agent-link', AGENT_LINK_TOKEN: 't', AGENT_LINK_ALLOW_INSECURE: 'true' })).not.toHaveProperty('problem');
  });
});

describe('nextRetryMs', () => {
  it('doubles from 1 s and stops at 30 s', () => {
    const delays: number[] = [];
    let d: number | null = null;
    for (let i = 0; i < 8; i++) delays.push((d = nextRetryMs(d)));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe('startAgentLink', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });

  async function listen(server: Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(() => server.close());
    return (server.address() as AddressInfo).port;
  }

  /** A stand-in control plane that records each handshake and keeps the sockets. */
  async function controlPlane(accept: (headers: IncomingHttpHeaders) => boolean) {
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true });
    const handshakes: IncomingHttpHeaders[] = [];
    const sockets: WebSocket[] = [];
    http.on('upgrade', (req, socket, head) => {
      handshakes.push(req.headers);
      // The agent terminates its end on stop and on retry; a reset arriving
      // here with no listener fails the whole run as an unhandled error (#424).
      socket.on('error', () => undefined);
      if (!accept(req.headers)) return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => undefined);
        sockets.push(ws);
      });
    });
    const port = await listen(http);
    cleanup.push(() => sockets.forEach((s) => s.terminate()));
    return { url: `ws://127.0.0.1:${port}/agent-link`, handshakes, sockets };
  }

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('sends its node id and token, and answers a stream from its own HTTP server', async () => {
    const agentHttp = createServer((req, res) => res.end(`agent saw ${req.method} ${req.url}`));
    const localPort = await listen(agentHttp);
    const cp = await controlPlane(() => true);

    const link: AgentLink = startAgentLink({ url: cp.url, token: 'secret-link-token', nodeId: 'node-nat', localPort, log: () => undefined });
    cleanup.push(() => link.stop());
    await until(() => cp.sockets.length === 1 && link.connected);

    expect(cp.handshakes[0]['x-nexus-node-id']).toBe('node-nat');
    expect(cp.handshakes[0].authorization).toBe('Bearer secret-link-token');

    const ws = cp.sockets[0];
    const session = new LinkSession(ws);
    ws.on('message', (data: Buffer) => session.receive(data));
    const stream = session.open();
    stream.end('GET /disk HTTP/1.1\r\nHost: agent\r\nConnection: close\r\n\r\n');
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    await once(stream, 'end');
    const response = Buffer.concat(chunks).toString();
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(response).toMatch(/agent saw GET \/disk$/);
  });

  it('keeps retrying a control plane that refuses it', async () => {
    const cp = await controlPlane(() => false);
    const link = startAgentLink({ url: cp.url, token: 't', nodeId: 'n', localPort: 1, firstRetryMs: 10, log: () => undefined });
    cleanup.push(() => link.stop());
    await until(() => cp.handshakes.length >= 2);
    expect(link.connected).toBe(false);
  });

  it('reconnects after the link drops', async () => {
    const cp = await controlPlane(() => true);
    const link = startAgentLink({ url: cp.url, token: 't', nodeId: 'n', localPort: 1, firstRetryMs: 10, log: () => undefined });
    cleanup.push(() => link.stop());
    await until(() => cp.sockets.length === 1 && link.connected);
    cp.sockets[0].terminate();
    await until(() => cp.sockets.length === 2);
  });
});
