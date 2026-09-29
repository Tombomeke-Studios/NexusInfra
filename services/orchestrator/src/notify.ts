import { createHmac } from 'crypto';
import { isIP } from 'net';
import { nodeHealth } from './nodeRegistry.js';
import type { NodeHealth, NodeRecord } from './types.js';

// Notifications (#236) — the pure half: what can be announced, what a message
// looks like on the wire, and who may subscribe to what. Delivery, retries and
// recipients live in notifier.ts.
//
// Before this a server could crash at 3am and nobody learned of it until they
// opened the panel.

export const SERVER_EVENTS = ['server.crashed', 'server.suspended'] as const;
/** Fleet events — for the people who run the nodes, not the people who run servers on them. */
export const NODE_EVENTS = ['node.offline', 'node.recovered'] as const;
export const NOTIFICATION_EVENTS = [...SERVER_EVENTS, ...NODE_EVENTS] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number] | 'test';

export const WEBHOOK_FORMATS = ['json', 'discord', 'slack'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface Notification {
  event: NotificationEvent;
  occurredAt: string;
  /** One line a person can act on. */
  summary: string;
  server?: { id: string; name: string };
  node?: { id: string; name: string };
  details?: Record<string, unknown>;
}

/**
 * The request body for a webhook. JSON carries everything; Discord and Slack
 * each want one line of text under their own key, and anything else is ignored
 * or refused by them.
 */
export function webhookBody(n: Notification, format: WebhookFormat): string {
  if (format === 'discord') return JSON.stringify({ content: `**NexusInfra** · ${n.summary}` });
  if (format === 'slack') return JSON.stringify({ text: `*NexusInfra* · ${n.summary}` });
  return JSON.stringify(n);
}

/** `X-NexusInfra-Signature`: HMAC-SHA256 of the exact body, keyed with the channel's secret. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * How long to wait before attempt `attempts + 1`, or null to give up. About a
 * day in total: long enough to ride out an outage at the receiving end, short
 * enough that a dead endpoint stops being retried.
 */
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
export function nextAttemptDelayMs(attempts: number): number | null {
  return attempts >= 1 && attempts <= BACKOFF_MS.length ? BACKOFF_MS[attempts - 1] : null;
}

/**
 * Whether an address is on a private, loopback, link-local or otherwise
 * non-public network. A webhook is the orchestrator making a request on a
 * user's behalf; without this a user could point it at the node agents, the
 * cloud metadata endpoint (169.254.169.254) or anything else only the server can
 * reach.
 */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast and reserved
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === '::' || lower === '::1' || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return true; // not an address at all: refuse rather than guess
}

export interface ChannelInput {
  kind: 'webhook' | 'email';
  target: string;
  format: WebhookFormat;
  events: Exclude<NotificationEvent, 'test'>[];
}

/**
 * Validate a new channel for an account. Email goes only to the account's own
 * address — a panel that mailed any address on request would be a spam relay
 * with a login page.
 */
export function parseChannelInput(
  body: unknown,
  account: { email: string; platformRole: string },
): { ok: true; channel: ChannelInput } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const events = input.events;
  const admin = account.platformRole === 'admin' || account.platformRole === 'owner';
  if (!Array.isArray(events) || events.length === 0) return { ok: false, error: 'choose at least one event' };
  for (const e of events) {
    if (!(NOTIFICATION_EVENTS as readonly unknown[]).includes(e)) return { ok: false, error: `unknown event ${String(e)}` };
    if ((NODE_EVENTS as readonly unknown[]).includes(e) && !admin) return { ok: false, error: 'node events are for platform administrators' };
  }
  const chosen = [...new Set(events)] as ChannelInput['events'];

  if (input.kind === 'email') {
    const target = typeof input.target === 'string' && input.target.trim() ? input.target.trim().toLowerCase() : account.email;
    if (target !== account.email.toLowerCase()) return { ok: false, error: 'email notifications go to your own address' };
    return { ok: true, channel: { kind: 'email', target, format: 'json', events: chosen } };
  }

  if (input.kind === 'webhook') {
    const format = input.format === undefined ? 'json' : input.format;
    if (!(WEBHOOK_FORMATS as readonly unknown[]).includes(format)) return { ok: false, error: `format must be one of ${WEBHOOK_FORMATS.join(', ')}` };
    let url: URL;
    try {
      url = new URL(String(input.target ?? ''));
    } catch {
      return { ok: false, error: 'target must be a URL' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'a webhook must be http or https' };
    return { ok: true, channel: { kind: 'webhook', target: url.toString(), format: format as WebhookFormat, events: chosen } };
  }

  return { ok: false, error: 'kind must be webhook or email' };
}

export interface NodeChange {
  nodeId: string;
  name: string;
  to: 'offline' | 'recovered';
}

/**
 * What changed about the fleet since the last look. `offline` and back is news;
 * a wobble through `degraded` is not. The first look only records — an
 * orchestrator that restarts must not announce every node it finds offline.
 */
export function nodeTransitions(
  previous: Map<string, NodeHealth>,
  nodes: Pick<NodeRecord, 'id' | 'name' | 'lastHeartbeat'>[],
  now: number,
): { changes: NodeChange[]; next: Map<string, NodeHealth> } {
  const next = new Map<string, NodeHealth>();
  const changes: NodeChange[] = [];
  for (const n of nodes) {
    const health = nodeHealth(n as NodeRecord, now);
    next.set(n.id, health);
    const was = previous.get(n.id);
    if (was === undefined) continue;
    if (health === 'offline' && was !== 'offline') changes.push({ nodeId: n.id, name: n.name, to: 'offline' });
    if (health === 'healthy' && was === 'offline') changes.push({ nodeId: n.id, name: n.name, to: 'recovered' });
  }
  return { changes, next };
}
