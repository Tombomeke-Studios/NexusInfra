import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { isPrivateAddress, nextAttemptDelayMs, nodeTransitions, parseChannelInput, signBody, webhookBody, type Notification } from './notify.js';

const crash: Notification = {
  event: 'server.crashed',
  occurredAt: '2026-09-25T03:00:00.000Z',
  summary: 'survival crashed: exited with code 137',
  server: { id: 'd1', name: 'survival' },
  details: { reason: 'exited with code 137' },
};

describe('webhookBody (#236)', () => {
  it('sends the whole notification as JSON by default', () => {
    expect(JSON.parse(webhookBody(crash, 'json'))).toEqual(crash);
  });

  it('speaks Discord and Slack, which want one line of text', () => {
    expect(JSON.parse(webhookBody(crash, 'discord'))).toEqual({ content: '**NexusInfra** · survival crashed: exited with code 137' });
    expect(JSON.parse(webhookBody(crash, 'slack'))).toEqual({ text: '*NexusInfra* · survival crashed: exited with code 137' });
  });
});

describe('signBody', () => {
  it('is an HMAC-SHA256 of the exact body, so a receiver can check it came from here', () => {
    const body = webhookBody(crash, 'json');
    expect(signBody('s3cret', body)).toBe(`sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`);
  });
});

describe('nextAttemptDelayMs', () => {
  it('backs off, then gives up rather than retrying forever', () => {
    const delays = [1, 2, 3, 4, 5, 6].map(nextAttemptDelayMs);
    expect(delays.every((d, i) => d !== null && (i === 0 || d > delays[i - 1]!))).toBe(true);
    expect(nextAttemptDelayMs(7)).toBeNull();
  });
});

describe('isPrivateAddress — no webhook into the private network (#236)', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])(
    '%s is private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true)
  );

  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('parseChannelInput', () => {
  const account = { email: 'ada@example.com', platformRole: 'user' };

  it('accepts a webhook with events', () => {
    expect(parseChannelInput({ kind: 'webhook', target: 'https://hooks.example.com/x', events: ['server.crashed'] }, account)).toEqual({
      ok: true,
      channel: { kind: 'webhook', target: 'https://hooks.example.com/x', format: 'json', events: ['server.crashed'] },
    });
  });

  it('sends email only to the account itself — the panel is not a mailer', () => {
    expect(parseChannelInput({ kind: 'email', events: ['server.crashed'] }, account)).toMatchObject({ ok: true, channel: { target: 'ada@example.com' } });
    expect(parseChannelInput({ kind: 'email', target: 'someone@else.com', events: ['server.crashed'] }, account).ok).toBe(false);
  });

  it('keeps node events to the people who run the nodes', () => {
    expect(parseChannelInput({ kind: 'webhook', target: 'https://x.io', events: ['node.offline'] }, account).ok).toBe(false);
    expect(parseChannelInput({ kind: 'webhook', target: 'https://x.io', events: ['node.offline'] }, { ...account, platformRole: 'admin' }).ok).toBe(true);
  });

  it('refuses what cannot be delivered', () => {
    for (const bad of [
      { kind: 'sms', events: ['server.crashed'] },
      { kind: 'webhook', target: 'ftp://x.io', events: ['server.crashed'] },
      { kind: 'webhook', target: 'not a url', events: ['server.crashed'] },
      { kind: 'webhook', target: 'https://x.io', events: [] },
      { kind: 'webhook', target: 'https://x.io', events: ['everything'] },
      { kind: 'webhook', target: 'https://x.io', events: ['server.crashed'], format: 'teams' },
    ]) {
      expect(parseChannelInput(bad, account).ok).toBe(false);
    }
  });
});

describe('nodeTransitions', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, 0) + ms);
  const node = (id: string, beatMsAgo: number, now: Date) => ({ id, name: id, lastHeartbeat: new Date(now.getTime() - beatMsAgo).toISOString() });

  it('says nothing on the first look — an orchestrator restart is not an outage', () => {
    const now = at(0);
    expect(nodeTransitions(new Map(), [node('a', 60_000, now)], now.getTime()).changes).toEqual([]);
  });

  it('reports a node going offline, and coming back', () => {
    let now = at(0);
    let r = nodeTransitions(new Map(), [node('a', 100, now)], now.getTime());
    now = at(30_000);
    r = nodeTransitions(r.next, [node('a', 20_000, now)], now.getTime());
    expect(r.changes).toEqual([{ nodeId: 'a', name: 'a', to: 'offline' }]);
    now = at(60_000);
    r = nodeTransitions(r.next, [node('a', 100, now)], now.getTime());
    expect(r.changes).toEqual([{ nodeId: 'a', name: 'a', to: 'recovered' }]);
  });

  it('does not treat a wobble through degraded as an outage', () => {
    let now = at(0);
    let r = nodeTransitions(new Map(), [node('a', 100, now)], now.getTime());
    now = at(5_000);
    r = nodeTransitions(r.next, [node('a', 5_000, now)], now.getTime());
    now = at(6_000);
    r = nodeTransitions(r.next, [node('a', 100, now)], now.getTime());
    expect(r.changes).toEqual([]);
  });
});
