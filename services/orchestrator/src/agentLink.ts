import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { keepLinkAlive, LINK_NODE_HEADER, LinkSession, type LinkSocket, type LinkStream, type PingableSocket } from 'shared';

// The orchestrator's half of the agent link (#416).
//
// A node behind NAT has no address the orchestrator can call, so its agent
// dials in instead and keeps one WebSocket open; the orchestrator's calls to
// that agent go back over it as byte streams. Everything that talks to an agent
// keeps building the same requests — only the connection under them differs:
//
//   - an outbound node's agent URL is a name nothing resolves
//     (`http://<hex node id>.agent-link.invalid`), so every call site that
//     appends a path to `agentUrlFor(nodeId)` stays as it is;
//   - `linkFetch` sends those through an undici Agent whose `connect` opens a
//     stream on the node's link instead of a TCP socket;
//   - the terminal proxy passes `createConnection` to `ws` for the same reason.
//
// The link credential is per node, never the shared INTERNAL_API_TOKEN: with a
// shared secret one node could open a link as another and be sent that node's
// file and shell traffic. Only the token's digest is stored.

/** The reason a call to an outbound node without a link answers 502. Part of the contract. */
export const NO_LINK = 'node has no agent link';

const LINK_HOST_SUFFIX = '.agent-link.invalid';
// DNS labels hold 63 characters; hex in 62s keeps each label whole.
const LABEL_CHARS = 62;
const MAX_HOST_CHARS = 253;

/** The agent base URL for an outbound node: a name only `linkFetch` understands. */
export function linkBaseUrl(nodeId: string): string {
  const hex = Buffer.from(nodeId, 'utf8').toString('hex');
  const labels = hex.match(new RegExp(`.{1,${LABEL_CHARS}}`, 'g')) ?? [];
  const host = `${labels.join('.')}${LINK_HOST_SUFFIX}`;
  if (!hex || host.length > MAX_HOST_CHARS) throw new Error('node id is too long for an agent link');
  return `http://${host}`;
}

/** The node an agent-link host names, or null for an ordinary host. */
export function nodeIdFromLinkHost(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (!host.endsWith(LINK_HOST_SUFFIX)) return null;
  const hex = host.slice(0, -LINK_HOST_SUFFIX.length).replace(/\./g, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('utf8');
}

/** The node an agent URL reaches over a link, or null for a direct URL. */
export function linkNodeOf(url: string): string | null {
  try {
    return nodeIdFromLinkHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * A new link token and the digest to store. 256 random bits, so a plain SHA-256
 * is enough — there is nothing to brute-force that a slow hash would slow down.
 */
export function mintLinkToken(): { token: string; hash: string } {
  const token = `nxl_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashLinkToken(token) };
}

/** Constant-time: whether `token` is the one whose digest is `storedHash`. */
export function linkTokenMatches(token: string, storedHash: string): boolean {
  const given = Buffer.from(hashLinkToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
}

/**
 * Which node a link handshake is for, or null to refuse it. The token must
 * match the digest stored for *that* node id — a token minted for another node
 * opens nothing here.
 */
export async function authorizeLink(
  headers: IncomingHttpHeaders,
  storedHashFor: (nodeId: string) => Promise<string | null>
): Promise<string | null> {
  const raw = headers[LINK_NODE_HEADER];
  const nodeId = typeof raw === 'string' ? raw.trim() : '';
  const token = bearer(headers.authorization);
  if (!nodeId || !token) return null;
  const stored = await storedHashFor(nodeId);
  if (!stored) return null;
  return linkTokenMatches(token, stored) ? nodeId : null;
}

/** The part of a `ws` WebSocket a registered link needs. */
export interface LinkWebSocket extends LinkSocket, PingableSocket {
  on(event: 'message', cb: (data: Buffer, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  on(event: 'pong' | 'ping', cb: () => void): unknown;
  close(code?: number, reason?: string): void;
}

interface Link {
  socket: LinkWebSocket;
  session: LinkSession;
}

/** The links up right now, one per node. */
export class LinkRegistry {
  private readonly links = new Map<string, Link>();

  /** Take a node's new link; one it already had is closed — a new link replaces the old. */
  attach(nodeId: string, socket: LinkWebSocket, options: { keepAlive?: boolean } = {}): void {
    this.close(nodeId, 'replaced by a new link');
    const session = new LinkSession(socket);
    const link: Link = { socket, session };
    this.links.set(nodeId, link);
    const stopKeepAlive = options.keepAlive === false ? () => undefined : keepLinkAlive(socket);
    socket.on('message', (data, isBinary) => {
      if (isBinary) session.receive(data);
    });
    socket.on('close', () => {
      stopKeepAlive();
      session.close('agent link closed');
      // Only forget the link if it is still this one — a replacement may already be in.
      if (this.links.get(nodeId) === link) this.links.delete(nodeId);
    });
  }

  isLinked(nodeId: string): boolean {
    return this.links.has(nodeId);
  }

  /** A new stream to the node's agent, or null when the node has no link. */
  open(nodeId: string): LinkStream | null {
    const link = this.links.get(nodeId);
    if (!link || link.session.isClosed) return null;
    return link.session.open();
  }

  /** Close a node's link (on token rotation, or replacement). */
  close(nodeId: string, reason = 'link closed by the control plane'): void {
    const link = this.links.get(nodeId);
    if (!link) return;
    this.links.delete(nodeId);
    link.session.close(reason);
    try {
      link.socket.close(4000, reason);
    } catch {
      link.socket.terminate();
    }
  }

  get size(): number {
    return this.links.size;
  }
}

/** The process's links — the one registry the upgrade handler and every agent call share. */
export const agentLinks = new LinkRegistry();

/**
 * An undici dispatcher whose connections are streams on agent links. Pooling
 * and keep-alive work as with TCP: each node's link is its own origin.
 */
export function createLinkDispatcher(registry: LinkRegistry): Agent {
  return new Agent({
    connect(options, callback) {
      const nodeId = nodeIdFromLinkHost(options.hostname);
      const stream = nodeId ? registry.open(nodeId) : null;
      // undici expects the callback later, as a real connect would call it: called
      // synchronously, the request is never written.
      setImmediate(() => {
        if (!stream) return callback(new Error(NO_LINK), null);
        // A LinkStream carries the socket methods undici calls; it is not a net.Socket.
        callback(null, stream as unknown as Socket);
      });
    },
  });
}

const dispatchers = new WeakMap<LinkRegistry, Agent>();

/** The 502 a call to an outbound node answers while that node has no link. */
export function noLinkResponse(): Response {
  return new Response(JSON.stringify({ error: NO_LINK }), { status: 502, headers: { 'content-type': 'application/json' } });
}

/** `fetch` to an agent-link URL: over the node's link, or the 502 when it has none. */
export async function linkFetch(registry: LinkRegistry, nodeId: string, url: string, init: RequestInit): Promise<Response> {
  if (!registry.isLinked(nodeId)) return noLinkResponse();
  let dispatcher = dispatchers.get(registry);
  if (!dispatcher) dispatchers.set(registry, (dispatcher = createLinkDispatcher(registry)));
  // undici's own fetch, so the dispatcher is one it understands; its Response is
  // the same web Response every caller already reads.
  const response = await undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher } as Parameters<typeof undiciFetch>[1]);
  return response as unknown as Response;
}

/** For the terminal proxy: a `ws` client option that dials over the node's link. */
export function linkConnection(registry: LinkRegistry, nodeId: string): (() => LinkStream) | null {
  if (!registry.isLinked(nodeId)) return null;
  return () => {
    const stream = registry.open(nodeId);
    if (!stream) throw new Error(NO_LINK);
    return stream;
  };
}
