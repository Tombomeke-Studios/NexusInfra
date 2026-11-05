import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { LinkSession } from 'shared';
import {
  authorizeLink,
  hashLinkToken,
  linkBaseUrl,
  linkConnection,
  linkFetch,
  linkNodeOf,
  linkTokenMatches,
  LinkRegistry,
  mintLinkToken,
  nodeIdFromLinkHost,
  NO_LINK,
} from './agentLink.js';
import { resolveAgentUrl } from './agentUrl.js';

describe('link URLs', () => {
  it('round-trips a node id through a name nothing resolves', () => {
    for (const id of ['node-1', 'Laptop_School.VM', 'n'.repeat(100)]) {
      const url = linkBaseUrl(id);
      expect(url).toMatch(/^http:\/\/[0-9a-f.]+\.agent-link\.invalid$/);
      expect(linkNodeOf(`${url}/disk`)).toBe(id);
    }
  });

  it('is not fooled by an ordinary host', () => {
    expect(linkNodeOf('http://node-agent:9100/disk')).toBeNull();
    expect(nodeIdFromLinkHost('zz.agent-link.invalid')).toBeNull();
  });

  it('refuses a node id too long to name', () => {
    expect(() => linkBaseUrl('n'.repeat(200))).toThrow(/too long/);
  });

  it('is what an outbound node resolves to, whatever address it once had; a direct node is unchanged', () => {
    expect(resolveAgentUrl({ id: 'nat', connection: 'outbound', agentUrl: 'http://10.0.0.5:9100' }, 'http://fallback:9100')).toBe(linkBaseUrl('nat'));
    expect(resolveAgentUrl({ id: 'lan', connection: 'direct', agentUrl: 'http://10.0.0.6:9100/' }, 'http://fallback:9100')).toBe('http://10.0.0.6:9100');
    expect(resolveAgentUrl({ id: 'lan', connection: 'direct', agentUrl: null }, 'http://fallback:9100')).toBe('http://fallback:9100');
  });
});

describe('link tokens', () => {
  it('mints a random token and stores only its digest', () => {
    const a = mintLinkToken();
    const b = mintLinkToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashLinkToken(a.token));
    expect(a.hash).not.toContain(a.token);
    expect(linkTokenMatches(a.token, a.hash)).toBe(true);
    expect(linkTokenMatches(b.token, a.hash)).toBe(false);
  });

  it('accepts a handshake only for the node the token was minted for', async () => {
    const nat = mintLinkToken();
    const other = mintLinkToken();
    const stored = new Map([
      ['nat', nat.hash],
      ['other', other.hash],
    ]);
    const lookup = async (id: string) => stored.get(id) ?? null;
    const hs = (node: string | undefined, token: string | undefined) => ({
      ...(node ? { 'x-nexus-node-id': node } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    });

    expect(await authorizeLink(hs('nat', nat.token), lookup)).toBe('nat');
    // Another node's token opens nothing here.
    expect(await authorizeLink(hs('nat', other.token), lookup)).toBeNull();
    expect(await authorizeLink(hs('ghost', nat.token), lookup)).toBeNull();
    expect(await authorizeLink(hs('nat', undefined), lookup)).toBeNull();
    expect(await authorizeLink(hs(undefined, nat.token), lookup)).toBeNull();
  });
});

describe('agent calls over a link', () => {
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

  /**
   * A control plane with a registry, and an agent that dialled it: the agent
   * side pipes every stream into `agentHttp`, as the real agent does.
   */
  async function linkedAgent(agentHttp: Server, nodeId = 'nat') {
    const agentPort = await listen(agentHttp);
    const registry = new LinkRegistry();
    const cp = createServer();
    const wss = new WebSocketServer({ noServer: true });
    cp.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => registry.attach(nodeId, ws, { keepAlive: false })));
    const cpPort = await listen(cp);

    const agentWs = new WebSocket(`ws://127.0.0.1:${cpPort}/agent-link`);
    cleanup.push(() => agentWs.terminate());
    const session = new LinkSession(agentWs, {
      onOpen(stream) {
        const local = net.connect({ host: '127.0.0.1', port: agentPort });
        local.on('error', (e) => stream.destroy(e));
        stream.on('close', () => local.destroy());
        stream.pipe(local);
        local.pipe(stream);
      },
    });
    agentWs.on('message', (data: Buffer, isBinary) => isBinary && session.receive(data));
    await once(agentWs, 'open');
    for (let i = 0; i < 100 && !registry.isLinked(nodeId); i++) await new Promise((r) => setTimeout(r, 5));
    return { registry, agentWs };
  }

  it('answers 502 "node has no agent link" while the node has none', async () => {
    const r = await linkFetch(new LinkRegistry(), 'nat', `${linkBaseUrl('nat')}/disk`, {});
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: NO_LINK });
  });

  it('carries a request, its headers and its body, and the answer', async () => {
    const seen: Array<{ method?: string; url?: string; token?: string; body: string }> = [];
    const agent = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, token: req.headers['x-internal-token'] as string, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, echoed: body }));
      });
    });
    const { registry } = await linkedAgent(agent);

    const get = await linkFetch(registry, 'nat', `${linkBaseUrl('nat')}/disk`, { headers: { 'x-internal-token': 'shh' } });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ok: true, echoed: '' });

    const post = await linkFetch(registry, 'nat', `${linkBaseUrl('nat')}/files/c1/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-internal-token': 'shh' },
      body: JSON.stringify({ path: '/a', content: 'x'.repeat(200_000) }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()).echoed.length).toBeGreaterThan(200_000);
    expect(seen.map((s) => [s.method, s.url, s.token])).toEqual([
      ['GET', '/disk', 'shh'],
      ['PUT', '/files/c1/content', 'shh'],
    ]);
  });

  it('streams server-sent events as they are written', async () => {
    const agent = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 50);
    });
    const { registry } = await linkedAgent(agent);
    const r = await linkFetch(registry, 'nat', `${linkBaseUrl('nat')}/logs/c1`, {});
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toBe('data: one\n\n');
    let rest = '';
    for (let c = await reader.read(); !c.done; c = await reader.read()) rest += Buffer.from(c.value!).toString();
    expect(rest).toBe('data: two\n\n');
  });

  it('carries the terminal WebSocket unchanged', async () => {
    const agent = createServer();
    const terminal = new WebSocketServer({ server: agent });
    terminal.on('connection', (ws, req) => {
      ws.send(`token ${req.headers['x-internal-token']}`);
      ws.on('message', (d) => ws.send(`echo ${d}`));
    });
    const { registry } = await linkedAgent(agent);
    const createConnection = linkConnection(registry, 'nat');
    expect(createConnection).not.toBeNull();
    const ws = new WebSocket(`ws://${new URL(linkBaseUrl('nat')).host}/terminal/c1`, {
      headers: { 'x-internal-token': 'shh' },
      createConnection: createConnection as never,
    });
    cleanup.push(() => ws.terminate());
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    await once(ws, 'open');
    ws.send('ls');
    for (let i = 0; i < 100 && messages.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(messages).toEqual(['token shh', 'echo ls']);
    expect(linkConnection(new LinkRegistry(), 'nat')).toBeNull();
  });

  it('fails calls in flight when the link is closed, and answers 502 after', async () => {
    const agent = createServer(() => undefined); // never answers
    const { registry } = await linkedAgent(agent);
    const pending = linkFetch(registry, 'nat', `${linkBaseUrl('nat')}/disk`, {});
    await new Promise((r) => setTimeout(r, 30));
    registry.close('nat', 'link token rotated');
    await expect(pending).rejects.toThrow();
    expect(registry.isLinked('nat')).toBe(false);
    expect((await linkFetch(registry, 'nat', `${linkBaseUrl('nat')}/disk`, {})).status).toBe(502);
  });

  it('keeps one link per node: a new one replaces the old', async () => {
    const agent = createServer((_req, res) => res.end('ok'));
    const { registry, agentWs } = await linkedAgent(agent);
    const closed = once(agentWs, 'close');
    const replacement = { closes: 0 };
    const fake = {
      bufferedAmount: 0,
      send: () => undefined,
      ping: () => undefined,
      terminate: () => undefined,
      close: () => void replacement.closes++,
      on: () => undefined,
    };
    registry.attach('nat', fake, { keepAlive: false });
    const [code] = await closed;
    expect(code).toBe(4000);
    expect(registry.isLinked('nat')).toBe(true);
    expect(registry.size).toBe(1);
  });
});
