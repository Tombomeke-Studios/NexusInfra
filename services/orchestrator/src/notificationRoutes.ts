import { randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { Router, type Request, type Response } from 'express';
import { principalOf } from './auth.js';
import { isPrivateAddress, NODE_EVENTS, NOTIFICATION_EVENTS, parseChannelInput } from './notify.js';
import type { Notifier } from './notifier.js';
import type { NotificationChannelRecord, Repository } from './types.js';

// An account's notification channels (#236) — under /me, so a channel is always
// the caller's own and no route takes a user id from the request.

/** A channel as the panel sees it: the webhook secret is shown once, at creation, and never again. */
function publicChannel(c: NotificationChannelRecord) {
  const { secret: _secret, allowPrivate: _allowPrivate, ...rest } = c;
  void _secret;
  void _allowPrivate;
  return { ...rest, signed: Boolean(c.secret) };
}

export function createNotificationRouter(deps: {
  repo: Repository;
  notifier: Notifier;
  /** Resolve a webhook's host at creation, to refuse a private one with a clear message. Injectable for tests. */
  resolveHost?: (host: string) => Promise<string[]>;
}): Router {
  const { repo, notifier } = deps;
  const resolveHost = deps.resolveHost ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  const router = Router();

  const ownChannel = async (req: Request, res: Response): Promise<NotificationChannelRecord | null> => {
    const channel = await repo.getNotificationChannel(req.params.id);
    // Someone else's channel answers exactly like a missing one.
    if (!channel || channel.userId !== principalOf(req).id) {
      res.status(404).json({ error: 'channel not found' });
      return null;
    }
    return channel;
  };

  router.get('/me/notifications', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    const admin = principal.platformRole === 'admin' || principal.platformRole === 'owner';
    const channels = await repo.listNotificationChannels([principal.id]);
    return res.json({
      channels: channels.map(publicChannel),
      capabilities: {
        email: notifier.emailEnabled,
        events: NOTIFICATION_EVENTS.filter((e) => admin || !(NODE_EVENTS as readonly string[]).includes(e)),
      },
    });
  });

  router.post('/me/notifications', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    const user = await repo.getUser(principal.id);
    if (!user) return res.status(404).json({ error: 'account not found' });
    const parsed = parseChannelInput(req.body, { email: user.email, platformRole: principal.platformRole });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { channel } = parsed;
    if (channel.kind === 'email' && !notifier.emailEnabled) {
      return res.status(400).json({ error: 'email is not configured on this installation — ask an administrator to set SMTP_URL' });
    }

    const admin = principal.platformRole === 'admin' || principal.platformRole === 'owner';
    if (channel.kind === 'webhook' && !admin) {
      // Refused here with a clear message; refused again at every send, where
      // the address actually connected to is the one checked (DNS rebinding).
      const host = new URL(channel.target).hostname.replace(/^\[|\]$/g, '');
      let addresses: string[];
      try {
        addresses = /^[\d.]+$|:/.test(host) ? [host] : await resolveHost(host);
      } catch {
        return res.status(400).json({ error: `${host} does not resolve` });
      }
      if (addresses.some(isPrivateAddress)) {
        return res.status(400).json({ error: `${host} is on a private network, which webhooks may not reach` });
      }
    }

    const secret = channel.kind === 'webhook' ? randomBytes(24).toString('hex') : null;
    const created = await repo.createNotificationChannel({ ...channel, userId: principal.id, secret, allowPrivate: channel.kind === 'webhook' && admin, enabled: true });
    // The secret once, now: a receiver needs it to check signatures.
    return res.status(201).json({ ...publicChannel(created), ...(secret ? { secret } : {}) });
  });

  router.patch('/me/notifications/:id', async (req: Request, res: Response) => {
    const channel = await ownChannel(req, res);
    if (!channel) return;
    const principal = principalOf(req);
    const { events, enabled } = req.body ?? {};
    let nextEvents: string[] | undefined;
    if (events !== undefined) {
      const user = await repo.getUser(principal.id);
      const parsed = parseChannelInput({ kind: channel.kind, target: channel.target, format: channel.format, events }, { email: user?.email ?? channel.target, platformRole: principal.platformRole });
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      nextEvents = parsed.channel.events;
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const updated = await repo.updateNotificationChannel(channel.id, { events: nextEvents, enabled });
    return res.json(publicChannel(updated!));
  });

  router.delete('/me/notifications/:id', async (req: Request, res: Response) => {
    const channel = await ownChannel(req, res);
    if (!channel) return;
    await repo.deleteNotificationChannel(channel.id);
    return res.status(204).end();
  });

  // Send a test message now and say what happened — the only way to find out a
  // URL is wrong before the 3am crash it was meant for.
  router.post('/me/notifications/:id/test', async (req: Request, res: Response) => {
    const channel = await ownChannel(req, res);
    if (!channel) return;
    const result = await notifier.sendNow(channel, {
      event: 'test',
      occurredAt: new Date().toISOString(),
      summary: 'Test notification — this channel works',
    });
    return res.status(result.ok ? 200 : 502).json(result);
  });

  router.get('/me/notifications/:id/deliveries', async (req: Request, res: Response) => {
    const channel = await ownChannel(req, res);
    if (!channel) return;
    const deliveries = await repo.listDeliveries(channel.id, 20);
    return res.json(deliveries.map(({ payload, ...d }) => ({ ...d, summary: (JSON.parse(payload) as { summary?: string }).summary ?? '' })));
  });

  return router;
}
