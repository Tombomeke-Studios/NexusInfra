import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createNotificationRouter } from './notificationRoutes.js';
import type { Notifier } from './notifier.js';

describe('notification channels API (#236)', () => {
  let repo: InMemoryRepository;
  let tested: string[];
  const notifier = (emailEnabled = true): Notifier => ({
    emailEnabled,
    notifyServer: async () => 0,
    notifyAdmins: async () => 0,
    drain: async () => 0,
    sendNow: async (c) => {
      tested.push(c.id);
      return c.target.includes('broken') ? { ok: false, error: 'the endpoint answered 404' } : { ok: true };
    },
  });

  const appAs = (id: string, platformRole: 'user' | 'admin' = 'user', emailEnabled = true) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { principal?: unknown }).principal = { id, platformRole };
      next();
    });
    app.use(
      createNotificationRouter({
        repo,
        notifier: notifier(emailEnabled),
        resolveHost: async (host) => (host.endsWith('.internal') ? ['10.0.0.5'] : ['93.184.216.34']),
      })
    );
    return app;
  };

  beforeEach(async () => {
    repo = new InMemoryRepository();
    tested = [];
    await repo.createUser({ id: 'ada', email: 'ada@example.com', displayName: 'Ada', passwordHash: '!', platformRole: 'user' });
    await repo.createUser({ id: 'bob', email: 'bob@example.com', displayName: 'Bob', passwordHash: '!', platformRole: 'user' });
    await repo.createUser({ id: 'root', email: 'root@example.com', displayName: 'Root', passwordHash: '!', platformRole: 'admin' });
  });

  it('creates a signed webhook and shows its secret exactly once', async () => {
    const app = appAs('ada');
    const res = await request(app).post('/me/notifications').send({ kind: 'webhook', target: 'https://hooks.example.com/x', format: 'discord', events: ['server.crashed'] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^[0-9a-f]{48}$/);
    const list = await request(app).get('/me/notifications');
    expect(list.body.channels).toHaveLength(1);
    expect(list.body.channels[0]).toMatchObject({ format: 'discord', signed: true });
    expect(list.body.channels[0].secret).toBeUndefined();
  });

  it("refuses a webhook into a private network for a regular account — the orchestrator's network is not theirs", async () => {
    const res = await request(appAs('ada')).post('/me/notifications').send({ kind: 'webhook', target: 'http://agent.internal:9100/x', events: ['server.crashed'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/private network/);
    await request(appAs('ada')).post('/me/notifications').send({ kind: 'webhook', target: 'http://169.254.169.254/latest', events: ['server.crashed'] }).expect(400);
  });

  it('lets a platform administrator point one at the local network, e.g. a home automation box', async () => {
    await request(appAs('root', 'admin')).post('/me/notifications').send({ kind: 'webhook', target: 'http://ha.internal:8123/hook', events: ['node.offline'] }).expect(201);
  });

  it('offers node events to administrators only', async () => {
    expect((await request(appAs('ada')).get('/me/notifications')).body.capabilities.events).toEqual(['server.crashed', 'server.suspended']);
    expect((await request(appAs('root', 'admin')).get('/me/notifications')).body.capabilities.events).toContain('node.offline');
  });

  it('refuses email when the installation has no SMTP, and says so', async () => {
    const res = await request(appAs('ada', 'user', false)).post('/me/notifications').send({ kind: 'email', events: ['server.crashed'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SMTP_URL/);
  });

  it("keeps each account to its own channels — someone else's is not found", async () => {
    const made = await request(appAs('ada')).post('/me/notifications').send({ kind: 'webhook', target: 'https://hooks.example.com/x', events: ['server.crashed'] });
    const bob = appAs('bob');
    expect((await request(bob).get('/me/notifications')).body.channels).toEqual([]);
    await request(bob).patch(`/me/notifications/${made.body.id}`).send({ enabled: false }).expect(404);
    await request(bob).delete(`/me/notifications/${made.body.id}`).expect(404);
    await request(bob).post(`/me/notifications/${made.body.id}/test`).expect(404);
  });

  it('turns a channel off, changes its events, and removes it', async () => {
    const app = appAs('ada');
    const made = await request(app).post('/me/notifications').send({ kind: 'webhook', target: 'https://hooks.example.com/x', events: ['server.crashed'] });
    expect((await request(app).patch(`/me/notifications/${made.body.id}`).send({ enabled: false, events: ['server.suspended'] })).body).toMatchObject({ enabled: false, events: ['server.suspended'] });
    await request(app).patch(`/me/notifications/${made.body.id}`).send({ events: ['node.offline'] }).expect(400);
    await request(app).delete(`/me/notifications/${made.body.id}`).expect(204);
    expect((await request(app).get('/me/notifications')).body.channels).toEqual([]);
  });

  it('sends a test and reports the answer', async () => {
    const app = appAs('ada');
    const good = await request(app).post('/me/notifications').send({ kind: 'webhook', target: 'https://hooks.example.com/x', events: ['server.crashed'] });
    const bad = await request(app).post('/me/notifications').send({ kind: 'webhook', target: 'https://hooks.example.com/broken', events: ['server.crashed'] });
    expect((await request(app).post(`/me/notifications/${good.body.id}/test`)).body).toEqual({ ok: true });
    const res = await request(app).post(`/me/notifications/${bad.body.id}/test`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('the endpoint answered 404');
  });
});
