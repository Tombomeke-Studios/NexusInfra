import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { InMemoryRepository } from './repository.js';
import { createNotifier, type NotifierTransports } from './notifier.js';

describe('notifier (#236)', () => {
  let repo: InMemoryRepository;
  let posts: Array<{ url: string; body: string; headers: Record<string, string>; allowPrivate: boolean }>;
  let mails: Array<{ to: string; subject: string }>;
  let status: number;
  let failWith: Error | null;
  let transports: NotifierTransports;
  let deploymentId: string;

  const user = (id: string, platformRole = 'user') =>
    repo.createUser({ id, email: `${id}@example.com`, displayName: id, passwordHash: '!', platformRole });
  const channel = (userId: string, over: Record<string, unknown> = {}) =>
    repo.createNotificationChannel({
      userId, kind: 'webhook', target: `https://hooks.example.com/${userId}`, format: 'json', events: ['server.crashed'], secret: 'k', allowPrivate: false, enabled: true, ...over,
    });

  beforeEach(async () => {
    repo = new InMemoryRepository();
    posts = [];
    mails = [];
    status = 200;
    failWith = null;
    transports = {
      post: async (url, body, headers, opts) => {
        if (failWith) throw failWith;
        posts.push({ url, body, headers, allowPrivate: opts.allowPrivate });
        return { status };
      },
      mail: async (to, subject) => void mails.push({ to, subject }),
    };
    await user('owner');
    const config = await repo.createServerConfig({ userId: 'owner', name: 'survival', dockerImage: 'x' });
    deploymentId = (await repo.createDeployment(config.id, 'n1')).id;
  });

  const notifier = (emailEnabled = true) => createNotifier({ repo, transports, emailEnabled });

  it('tells the owner, a shared user and the team, and nobody else', async () => {
    await user('guest');
    await user('mate');
    await user('stranger');
    await repo.createSubuser({ deploymentId, email: 'guest@example.com', role: 'viewer', userId: 'guest', status: 'active' });
    const team = await repo.createTeam({ id: 't1', name: 'crew', ownerId: 'owner' });
    await repo.addTeamMember({ teamId: team.id, userId: 'mate', role: 'viewer' });
    await repo.setServerTeam((await repo.getDeploymentConfig(deploymentId))!.id, team.id);
    for (const u of ['owner', 'guest', 'mate', 'stranger']) await channel(u);

    const n = notifier();
    expect(await n.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed: exited with code 137' })).toBe(3);
    await n.drain();
    expect(posts.map((p) => p.url).sort()).toEqual(['https://hooks.example.com/guest', 'https://hooks.example.com/mate', 'https://hooks.example.com/owner']);
    expect(JSON.parse(posts[0].body)).toMatchObject({ event: 'server.crashed', summary: 'survival crashed: exited with code 137', server: { id: deploymentId, name: 'survival' } });
  });

  it('respects what each channel asked for, and whether it is on', async () => {
    await channel('owner', { events: ['server.suspended'] });
    await channel('owner', { enabled: false });
    expect(await notifier().notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' })).toBe(0);
  });

  it('signs the exact body it sends, with an id that stays the same across retries', async () => {
    await channel('owner');
    const n = notifier();
    await n.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' });
    await n.drain();
    const [p] = posts;
    expect(p.headers['x-nexusinfra-signature']).toBe(`sha256=${createHmac('sha256', 'k').update(p.body).digest('hex')}`);
    expect(p.headers['x-nexusinfra-event']).toBe('server.crashed');
    expect(p.allowPrivate).toBe(false);
  });

  it('keeps a failed delivery and tries again later, instead of losing it', async () => {
    const c = await channel('owner');
    const n = notifier();
    failWith = new Error('connect ECONNREFUSED');
    await n.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' });
    await n.drain();

    const [d] = await repo.listDeliveries(c.id, 10);
    expect(d).toMatchObject({ status: 'pending', attempts: 1, lastError: 'connect ECONNREFUSED' });
    expect((await repo.getNotificationChannel(c.id))?.lastError).toBe('connect ECONNREFUSED');

    // Nothing is due yet; once it is, the retry lands.
    failWith = null;
    expect(await n.drain()).toBe(0);
    await n.drain(new Date(Date.now() + 60_000));
    expect((await repo.listDeliveries(c.id, 10))[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(posts).toHaveLength(1);
  });

  it('gives up at once on an answer that will not change, like 404', async () => {
    const c = await channel('owner');
    const n = notifier();
    status = 404;
    await n.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' });
    await n.drain();
    expect((await repo.listDeliveries(c.id, 10))[0]).toMatchObject({ status: 'failed', lastError: 'the endpoint answered 404' });
  });

  it('retries a server error, and eventually gives up', async () => {
    const c = await channel('owner');
    const n = notifier();
    status = 503;
    await n.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' });
    let t = Date.now();
    for (let i = 0; i < 10; i++) {
      await n.drain(new Date(t));
      t += 24 * 3_600_000;
    }
    const [d] = await repo.listDeliveries(c.id, 10);
    expect(d.status).toBe('failed');
    expect(d.attempts).toBe(7);
  });

  it('emails when email is configured, and fails plainly when it is not', async () => {
    const c = await channel('owner', { kind: 'email', target: 'owner@example.com' });
    const on = notifier();
    await on.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' });
    await on.drain();
    expect(mails).toEqual([{ to: 'owner@example.com', subject: '[NexusInfra] survival crashed' }]);

    const off = notifier(false);
    await off.notifyServer(deploymentId, { event: 'server.crashed', summary: 'crashed' });
    await off.drain();
    expect((await repo.listDeliveries(c.id, 10))[0]).toMatchObject({ status: 'failed', lastError: 'email is not configured on this installation' });
  });

  it('sends a delivery once even when two orchestrators drain at the same moment', async () => {
    await channel('owner');
    const a = notifier();
    const b = notifier();
    await repo.enqueueDeliveries([{ channelId: (await repo.listNotificationChannels(['owner']))[0].id, event: 'server.crashed', payload: JSON.stringify({ event: 'server.crashed', occurredAt: '', summary: 'x' }) }]);
    await Promise.all([a.drain(), b.drain()]);
    expect(posts).toHaveLength(1);
  });

  it('tells platform administrators about the fleet, and nobody else', async () => {
    await user('root', 'admin');
    await channel('root', { events: ['node.offline'] });
    await channel('owner', { events: ['node.offline'] });
    const n = notifier();
    expect(await n.notifyAdmins({ event: 'node.offline', summary: 'Node a is offline', node: { id: 'a', name: 'a' } })).toBe(1);
  });

  it('sends a test straight away and says whether it worked', async () => {
    const c = await channel('owner');
    expect(await notifier().sendNow(c, { event: 'test', occurredAt: '', summary: 'Test' })).toEqual({ ok: true });
    status = 500;
    expect(await notifier().sendNow(c, { event: 'test', occurredAt: '', summary: 'Test' })).toEqual({ ok: false, error: 'the endpoint answered 500' });
  });
});
