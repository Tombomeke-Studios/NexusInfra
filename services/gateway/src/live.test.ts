import { describe, it, expect, afterEach } from 'vitest';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { createGateway } from './gateway.js';
import { RateLimiter } from './rateLimit.js';

// Real sockets on both sides of the gateway. Streaming and upgrades are exactly
// the behaviour a stubbed `fetch` cannot show: whether bytes arrive before the
// response ends, and whether closing one side closes the other.

const SECRET = 'live-secret';
const TOKEN = jwt.sign({ sub: 'user-1' }, SECRET);
const verify = (t: string) => ({ userId: (jwt.verify(t, SECRET) as { sub: string }).sub });

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
});

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function gatewayFor(target: string, rateLimiter?: RateLimiter): Promise<string> {
  const { app, upgrade } = createGateway({ routes: [{ prefix: '/deployments', target }], verify, rateLimiter });
  const server = http.createServer(app);
  server.on('upgrade', upgrade);
  return listen(server);
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('streaming responses', () => {
  it('delivers a server-sent event before the stream ends', async () => {
    // A log tail never ends. Buffered, not one line of it ever reached the browser.
    const backend = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first line\n\n');
    }));
    const gateway = await gatewayFor(backend);

    const first = await new Promise<string>((resolve, reject) => {
      const req = http.get(`${gateway}/deployments/d1/logs`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.once('data', (chunk: Buffer) => {
          resolve(chunk.toString());
          req.destroy();
        });
      });
      req.on('error', reject);
    });
    expect(first).toBe('data: first line\n\n');
  });

  it('closes the backend stream when the client goes away', async () => {
    // Otherwise every closed tab leaves a stream open at the orchestrator and
    // at the node agent behind it, forever.
    let backendClosed = false;
    const backend = await listen(http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hi\n\n');
      req.on('close', () => (backendClosed = true));
    }));
    const gateway = await gatewayFor(backend);

    await new Promise<void>((resolve) => {
      const req = http.get(`${gateway}/deployments/d1/stats`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
    });
    await until(() => backendClosed);
  });

  it('passes a large body through intact', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    const backend = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
      res.end(payload);
    }));
    const gateway = await gatewayFor(backend);
    const res = await fetch(`${gateway}/deployments/d1/backups/b1/download`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get('content-length')).toBe(String(payload.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true);
  });
});

describe('WebSocket upgrades (#69)', () => {
  async function echoBackend() {
    const seen: { url?: string; headers?: http.IncomingHttpHeaders; closed: boolean } = { closed: false };
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      seen.url = req.url;
      seen.headers = req.headers;
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on('close', () => (seen.closed = true));
    });
    const url = await listen(server);
    return { url, seen, wss };
  }

  function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  const ws = (http: string) => http.replace(/^http/, 'ws');

  it('carries a terminal session both ways, text and binary', async () => {
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    const client = await open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}&cols=100&rows=30`);

    const text = new Promise((r) => client.once('message', (d, bin) => r([d.toString(), bin])));
    client.send(JSON.stringify({ type: 'input', data: 'ls\n' }));
    expect(await text).toEqual(['{"type":"input","data":"ls\\n"}', false]);

    const binary = new Promise<Buffer>((r) => client.once('message', (d) => r(d as Buffer)));
    client.send(Buffer.from([0, 1, 2, 255]));
    expect([...(await binary)]).toEqual([0, 1, 2, 255]);

    // The orchestrator authorizes the shell itself, so it needs the query intact.
    expect(backend.seen.url).toBe(`/deployments/d1/terminal?token=${TOKEN}&cols=100&rows=30`);
    expect(backend.seen.headers?.['x-user-id']).toBe('user-1');
    client.close();
  });

  it('closes the backend session when the browser closes', async () => {
    // A closed tab must not keep a root shell alive on the node.
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    const client = await open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`);
    client.close();
    await until(() => backend.seen.closed);
  });

  it('closes the browser socket when the backend ends the session', async () => {
    // The shell exited: the terminal must say so rather than hang.
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    const client = await open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`);
    const closed = new Promise((r) => client.once('close', r));
    for (const s of backend.wss.clients) s.close();
    await closed;
  });

  it('refuses a handshake without a token and never dials the backend', async () => {
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    await expect(open(`${ws(gateway)}/deployments/d1/terminal`)).rejects.toThrow('status 401');
    expect(backend.seen.url).toBeUndefined();
  });

  it('refuses a forged token', async () => {
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    const forged = jwt.sign({ sub: 'user-1' }, 'not-the-secret');
    await expect(open(`${ws(gateway)}/deployments/d1/terminal?token=${forged}`)).rejects.toThrow('status 401');
    expect(backend.seen.url).toBeUndefined();
  });

  it('accepts the token as a header for non-browser clients', async () => {
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    const client = await open(`${ws(gateway)}/deployments/d1/terminal`, { authorization: `Bearer ${TOKEN}` });
    client.close();
  });

  it('refuses an unrouted path', async () => {
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url);
    await expect(open(`${ws(gateway)}/elsewhere?token=${TOKEN}`)).rejects.toThrow('status 404');
  });

  it('rate-limits handshakes like any other request', async () => {
    // Otherwise a WebSocket is a way around the limiter.
    const backend = await echoBackend();
    const gateway = await gatewayFor(backend.url, new RateLimiter({ ratePerSec: 0, burst: 1 }));
    (await open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`)).close();
    await expect(open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`)).rejects.toThrow('status 429');
  });

  it("relays the backend's refusal", async () => {
    const backend = await listen(http.createServer((_req, res) => res.writeHead(403).end()));
    const gateway = await gatewayFor(backend);
    await expect(open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`)).rejects.toThrow('status 403');
  });

  it('answers 502 when the backend hangs up on the handshake', async () => {
    // What the orchestrator does to a caller without console access.
    const server = http.createServer();
    server.on('upgrade', (_req, socket) => socket.destroy());
    const gateway = await gatewayFor(await listen(server));
    await expect(open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`)).rejects.toThrow('status 502');
  });

  it('answers 502 when the backend is unreachable', async () => {
    const gateway = await gatewayFor('http://127.0.0.1:1');
    await expect(open(`${ws(gateway)}/deployments/d1/terminal?token=${TOKEN}`)).rejects.toThrow('status 502');
  });
});
