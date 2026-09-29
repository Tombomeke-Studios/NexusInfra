import { lookup as dnsLookup, type LookupAddress } from 'dns';
import http from 'http';
import https from 'https';
import { isPrivateAddress, nextAttemptDelayMs, signBody, webhookBody, type Notification, type WebhookFormat } from './notify.js';
import type { NotificationChannelRecord, Repository } from './types.js';

// Notifications (#236) — who hears about what, and getting it to them.
//
// Every notification becomes one delivery row per channel before anything is
// sent, and rows are retried with backoff (notify.ts) until they land or give
// up. A restart, a webhook that is down for an hour, an SMTP server that says
// "try later" — each delays a notification; none of them loses it.

export interface NotifierTransports {
  /** POST a webhook. `allowPrivate` false means the connection itself refuses private addresses. */
  post(url: string, body: string, headers: Record<string, string>, opts: { allowPrivate: boolean }): Promise<{ status: number }>;
  mail(to: string, subject: string, text: string): Promise<void>;
}

export interface Notifier {
  /** Tell everyone with access to a server who asked to hear about this. */
  notifyServer(deploymentId: string, n: Omit<Notification, 'occurredAt' | 'server'>): Promise<number>;
  /** Tell the platform's administrators — fleet events. */
  notifyAdmins(n: Omit<Notification, 'occurredAt'>): Promise<number>;
  /** Send what is due. Returns how many deliveries were attempted. */
  drain(now?: Date): Promise<number>;
  /** Send one message to one channel now, outside the queue — the Test button. */
  sendNow(channel: NotificationChannelRecord, n: Notification): Promise<{ ok: true } | { ok: false; error: string }>;
  readonly emailEnabled: boolean;
}

class PermanentFailure extends Error {}

export function createNotifier(deps: {
  repo: Repository;
  transports: NotifierTransports;
  emailEnabled: boolean;
  /** Told how each delivery attempt ended — for metrics (#246). */
  onOutcome?: (outcome: 'sent' | 'retrying' | 'failed', kind: string) => void;
}): Notifier {
  const { repo, transports } = deps;
  let draining: Promise<number> | null = null;

  /** Everyone who can see the server: owner, active shares, and its team. */
  async function peopleWithAccess(deploymentId: string): Promise<{ server: { id: string; name: string }; userIds: string[] } | null> {
    const d = await repo.getDeployment(deploymentId);
    if (!d) return null;
    const ids = new Set<string>([d.userId]);
    for (const s of await repo.listSubusers(d.id)) if (s.status === 'active' && s.userId) ids.add(s.userId);
    if (d.teamId) {
      const team = await repo.getTeam(d.teamId);
      if (team) ids.add(team.ownerId);
      for (const m of await repo.listTeamMembers(d.teamId)) ids.add(m.userId);
    }
    return { server: { id: d.id, name: d.name }, userIds: [...ids] };
  }

  async function enqueue(userIds: string[], n: Notification): Promise<number> {
    const channels = (await repo.listNotificationChannels(userIds)).filter((c) => c.enabled && c.events.includes(n.event));
    if (!channels.length) return 0;
    await repo.enqueueDeliveries(channels.map((c) => ({ channelId: c.id, event: n.event, payload: JSON.stringify(n) })));
    // Send now rather than at the next tick; the queue is for when that fails.
    void kick();
    return channels.length;
  }

  async function send(channel: NotificationChannelRecord, n: Notification, deliveryId: string): Promise<void> {
    if (channel.kind === 'email') {
      if (!deps.emailEnabled) throw new PermanentFailure('email is not configured on this installation');
      const text = [n.summary, '', ...(n.server ? [`Server: ${n.server.name}`] : []), ...(n.node ? [`Node: ${n.node.name}`] : []), `When: ${n.occurredAt}`].join('\n');
      await transports.mail(channel.target, `[NexusInfra] ${n.summary}`, text);
      return;
    }
    const body = webhookBody(n, channel.format as WebhookFormat);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'NexusInfra-Notifier',
      'x-nexusinfra-event': n.event,
      // Stable across retries, so a receiver can drop a duplicate.
      'x-nexusinfra-delivery': deliveryId,
      ...(channel.secret ? { 'x-nexusinfra-signature': signBody(channel.secret, body) } : {}),
    };
    const { status } = await transports.post(channel.target, body, headers, { allowPrivate: channel.allowPrivate });
    if (status >= 200 && status < 300) return;
    // A 4xx other than "slow down" will not fix itself by being asked again.
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw new PermanentFailure(`the endpoint answered ${status}`);
    throw new Error(`the endpoint answered ${status}`);
  }

  async function drainOnce(now: Date): Promise<number> {
    const due = await repo.listDueDeliveries(now.toISOString(), 50);
    for (const d of due) {
      const channel = await repo.getNotificationChannel(d.channelId);
      if (!channel || !channel.enabled) {
        await repo.updateDelivery(d.id, { status: 'failed', lastError: 'the channel was removed or turned off' });
        continue;
      }
      // Claim it first: only one drain — in this process or another — sends a row.
      if (!(await repo.claimDelivery(d.id, d.attempts))) continue;
      const attempts = d.attempts + 1;
      try {
        await send(channel, JSON.parse(d.payload) as Notification, d.id);
        await repo.updateDelivery(d.id, { status: 'sent', attempts, sentAt: now.toISOString(), lastError: null });
        deps.onOutcome?.('sent', channel.kind);
        await repo.updateNotificationChannel(channel.id, { lastDeliveryAt: now.toISOString(), lastError: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const delay = err instanceof PermanentFailure ? null : nextAttemptDelayMs(attempts);
        if (delay === null) {
          await repo.updateDelivery(d.id, { status: 'failed', attempts, lastError: message });
          deps.onOutcome?.('failed', channel.kind);
        } else {
          deps.onOutcome?.('retrying', channel.kind);
          await repo.updateDelivery(d.id, { attempts, lastError: message, nextAttemptAt: new Date(now.getTime() + delay).toISOString() });
        }
        await repo.updateNotificationChannel(channel.id, { lastError: message });
      }
    }
    return due.length;
  }

  // One drain at a time: a tick and a kick overlapping would send a row twice.
  function kick(now = new Date()): Promise<number> {
    if (draining) return draining;
    draining = drainOnce(now).finally(() => {
      draining = null;
    });
    return draining;
  }

  return {
    emailEnabled: deps.emailEnabled,
    async notifyServer(deploymentId, n) {
      const who = await peopleWithAccess(deploymentId);
      if (!who) return 0;
      // The summary names the server: a phone lock screen shows nothing else.
      return enqueue(who.userIds, { ...n, summary: `${who.server.name} ${n.summary}`, server: who.server, occurredAt: new Date().toISOString() });
    },
    async notifyAdmins(n) {
      const admins = (await repo.listUsers()).filter((u) => u.platformRole === 'admin' || u.platformRole === 'owner').map((u) => u.id);
      return enqueue(admins, { ...n, occurredAt: new Date().toISOString() });
    },
    drain: (now) => kick(now),
    async sendNow(channel, n) {
      try {
        await send(channel, n, `test-${Date.now()}`);
        await repo.updateNotificationChannel(channel.id, { lastDeliveryAt: new Date().toISOString(), lastError: null });
        return { ok: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await repo.updateNotificationChannel(channel.id, { lastError: error });
        return { ok: false, error };
      }
    },
  };
}

/**
 * A DNS lookup that refuses private addresses (#236). Given to the HTTP client
 * as its `lookup`, so the check applies to the address actually connected to —
 * a hostname that resolves publicly when the channel is saved and privately
 * when it is used (DNS rebinding) is still refused.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(Object.assign(new Error(`${hostname} resolves to a private address, which webhooks may not reach`), { code: 'EPRIVATE' }), '', 0);
      }
      if ((options as { all?: boolean }).all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/** The real transports: node's HTTP client with the guarded lookup, and nodemailer. */
export function defaultTransports(smtpUrl: string | undefined, from: string): NotifierTransports {
  return {
    post(url, body, headers, { allowPrivate }) {
      return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'https:' ? https : http;
        // An IP literal skips DNS entirely, so it is checked here instead.
        if (!allowPrivate && /^[\d.]+$|^\[.*\]$/.test(target.hostname) && isPrivateAddress(target.hostname.replace(/^\[|\]$/g, ''))) {
          return reject(new Error(`${target.hostname} is a private address, which webhooks may not reach`));
        }
        const req = client.request(target, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, lookup: guardedLookup(allowPrivate) as never, timeout: 10_000 }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on('timeout', () => req.destroy(new Error('the endpoint did not answer within 10 seconds')));
        req.on('error', reject);
        req.end(body);
      });
    },
    async mail(to, subject, text) {
      if (!smtpUrl) throw new Error('email is not configured on this installation');
      const nodemailer = await import('nodemailer');
      await nodemailer.createTransport(smtpUrl).sendMail({ from, to, subject, text });
    },
  };
}
