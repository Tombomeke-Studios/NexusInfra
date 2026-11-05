import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createApiRouter } from './api.js';
import { hashLinkToken, LinkRegistry, NO_LINK, type LinkWebSocket } from './agentLink.js';

// The node half of the agent link (#416): registering an outbound node, minting
// its token, and saying whether it can be controlled right now.

const ADMIN = { id: 'user-root', platformRole: 'admin' as const };
const USER = { id: 'user-plain', platformRole: 'user' as const };

function buildApp(repo: InMemoryRepository, links: LinkRegistry, principal: { id: string; platformRole: 'admin' | 'user' } = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { principal?: unknown }).principal = principal;
    next();
  });
  app.use(
    createApiRouter({
      repo,
      links,
      publish: async () => true,
      checkQuota: async () => ({ allowed: true, limit: Infinity }),
      getEntitlements: async () => null,
      getStanding: async () => null,
      diskUsage: async () => ({ measuredAt: 'now', deployments: [] }),
    })
  );
  return app;
}

/** A link that is up as far as the registry can tell. */
function fakeLink(): LinkWebSocket & { closedWith: Array<[number | undefined, string | undefined]> } {
  const closedWith: Array<[number | undefined, string | undefined]> = [];
  return {
    closedWith,
    bufferedAmount: 0,
    send: () => undefined,
    ping: () => undefined,
    terminate: () => undefined,
    close: (code, reason) => void closedWith.push([code, reason]),
    on: () => undefined,
  };
}

describe('outbound nodes', () => {
  let repo: InMemoryRepository;
  let links: LinkRegistry;
  let app: express.Express;

  beforeEach(() => {
    repo = new InMemoryRepository();
    links = new LinkRegistry();
    app = buildApp(repo, links);
  });

  it('registers a node as direct by default, exactly as before', async () => {
    const res = await request(app).post('/nodes').send({ id: 'lan', agentUrl: 'http://10.0.0.6:9100' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'lan', connection: 'direct', agentUrl: 'http://10.0.0.6:9100' });
    expect(res.body).not.toHaveProperty('linked');
  });

  it('registers an outbound node without an address, and ignores one if sent', async () => {
    const res = await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound', agentUrl: 'http://192.168.0.9:9100' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'nat', connection: 'outbound', agentUrl: null, linked: false });
  });

  it('keeps an existing node outbound when it is relabelled without saying', async () => {
    await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
    const res = await request(app).post('/nodes').send({ id: 'nat', name: 'School laptop' });
    expect(res.body).toMatchObject({ name: 'School laptop', connection: 'outbound' });
  });

  it('refuses a connection it does not know', async () => {
    expect((await request(app).post('/nodes').send({ id: 'x', connection: 'tunnel' })).status).toBe(400);
  });

  it('lists whether each outbound node is linked, and nothing of the kind for a direct one', async () => {
    await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
    await request(app).post('/nodes').send({ id: 'lan' });
    const before = (await request(app).get('/nodes')).body as Array<Record<string, unknown>>;
    expect(before.find((n) => n.id === 'nat')).toMatchObject({ connection: 'outbound', linked: false });
    expect(before.find((n) => n.id === 'lan')).not.toHaveProperty('linked');

    links.attach('nat', fakeLink(), { keepAlive: false });
    const after = (await request(app).get('/nodes')).body as Array<Record<string, unknown>>;
    expect(after.find((n) => n.id === 'nat')).toMatchObject({ linked: true });
  });

  it('never returns the link token digest', async () => {
    await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
    await request(app).post('/nodes/nat/link-token');
    const listed = JSON.stringify((await request(app).get('/nodes')).body);
    expect(listed).not.toMatch(/linkTokenHash/);
    expect(listed).not.toContain((await repo.getNodeLinkTokenHash('nat'))!);
  });

  describe('POST /nodes/:id/link-token', () => {
    it('mints a token once and stores only its digest', async () => {
      await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
      const res = await request(app).post('/nodes/nat/link-token');
      expect(res.status).toBe(201);
      expect(typeof res.body.token).toBe('string');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await repo.getNodeLinkTokenHash('nat')).toBe(hashLinkToken(res.body.token));
    });

    it('rotates: a second call replaces the token and closes the current link', async () => {
      await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
      const first = (await request(app).post('/nodes/nat/link-token')).body.token;
      const link = fakeLink();
      links.attach('nat', link, { keepAlive: false });

      const second = (await request(app).post('/nodes/nat/link-token')).body.token;
      expect(second).not.toBe(first);
      expect(await repo.getNodeLinkTokenHash('nat')).toBe(hashLinkToken(second));
      expect(links.isLinked('nat')).toBe(false);
      expect(link.closedWith).toEqual([[4000, 'link token rotated']]);
    });

    it('is a platform administrator’s', async () => {
      await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
      expect((await request(buildApp(repo, links, USER)).post('/nodes/nat/link-token')).status).toBe(403);
    });

    it('answers 404 for a node that does not exist', async () => {
      expect((await request(app).post('/nodes/ghost/link-token')).status).toBe(404);
    });
  });

  describe('GET /nodes/:id/disk', () => {
    it('answers 502 "node has no agent link" for an outbound node without one', async () => {
      await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
      const res = await request(app).get('/nodes/nat/disk');
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: NO_LINK });
    });

    it('asks the agent once the link is up', async () => {
      await request(app).post('/nodes').send({ id: 'nat', connection: 'outbound' });
      links.attach('nat', fakeLink(), { keepAlive: false });
      expect((await request(app).get('/nodes/nat/disk')).status).toBe(200);
    });

    it('asks a direct node as before, link or no link', async () => {
      await request(app).post('/nodes').send({ id: 'lan', agentUrl: 'http://10.0.0.6:9100' });
      expect((await request(app).get('/nodes/lan/disk')).status).toBe(200);
    });
  });
});
