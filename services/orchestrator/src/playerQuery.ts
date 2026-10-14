import type { EggQuery } from './eggs.js';

// Is anybody on, and can anybody get on (#382) — the orchestrator's half.
//
// The node agent asks the game (it is on the host the port is published on);
// this decides *whether* to ask, *where*, and how often. Pure apart from the
// injected agent call.
//
// Every answer says what it knows and nothing more:
// - `online`      the game answered; players are what it said (null if hidden);
// - `offline`     the server runs but the game did not answer its status port;
// - `stopped`     the server is not running, so there is nobody to ask;
// - `unsupported` this kind of server has no status protocol we speak;
// - `unknown`     the node could not be asked.
// None of the last four carries a player count: "0 players" is a claim, and
// these are the cases where nobody knows.

export type QueryProtocol = EggQuery['protocol'];
export type ServerQueryStatus = 'online' | 'offline' | 'stopped' | 'unsupported' | 'unknown';

export interface ServerQuery {
  status: ServerQueryStatus;
  protocol: QueryProtocol | null;
  players: { online: number; max: number } | null;
  version: string | null;
  motd: string | null;
  name: string | null;
  map: string | null;
  latencyMs: number | null;
  /** When the game was last asked — answers are cached, so this can be seconds ago. */
  checkedAt: string;
  /** Why it is offline or unknown, in words. */
  error?: string;
}

export interface QueryTarget {
  protocol: QueryProtocol;
  /** The host port the container port is published on. */
  hostPort: number;
}

/**
 * Which host port to ask on: the one whose container side is the egg's query
 * port. The creator may have published it on another host port, so the egg's
 * own default would be the wrong place to look. Null when it is not published.
 */
export function queryTargetFor(query: EggQuery | undefined, ports: Record<string, string>): QueryTarget | null {
  if (!query) return null;
  for (const [host, container] of Object.entries(ports)) {
    if (String(container).trim().split('/')[0] !== query.port) continue;
    const hostPort = Number(host);
    if (Number.isInteger(hostPort) && hostPort >= 1 && hostPort <= 65535) return { protocol: query.protocol, hostPort };
  }
  return null;
}

export function emptyQuery(status: ServerQueryStatus, extra: Partial<ServerQuery> = {}, now = new Date()): ServerQuery {
  return {
    status,
    protocol: null,
    players: null,
    version: null,
    motd: null,
    name: null,
    map: null,
    latencyMs: null,
    checkedAt: now.toISOString(),
    ...extra,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const nonNegInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The agent's answer, checked rather than trusted: an agent from before #382
 * answers 404, and anything that does not have the expected shape is `unknown`
 * — a malformed reply must not render as a server with zero players.
 */
export function fromAgentAnswer(protocol: QueryProtocol, body: unknown, now = new Date()): ServerQuery {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.status === 'offline') {
    return emptyQuery('offline', { protocol, error: str(b.error) ?? 'the server did not answer' }, now);
  }
  if (b.status !== 'online') return emptyQuery('unknown', { protocol, error: 'the node gave an answer this panel does not understand' }, now);

  const p = (b.players ?? null) as { online?: unknown; max?: unknown } | null;
  const online = nonNegInt(p?.online);
  const max = nonNegInt(p?.max);
  return {
    status: 'online',
    protocol,
    players: online !== null && max !== null ? { online, max } : null,
    version: str(b.version),
    motd: str(b.motd),
    name: str(b.name),
    map: str(b.map),
    latencyMs: nonNegInt(b.latencyMs),
    checkedAt: now.toISOString(),
  };
}

/**
 * One answer per server for `ttlMs`, and one question in flight at a time.
 *
 * The panel polls, every open tab polls, and the Servers list polls a row per
 * server; without this each of those is a packet to the game. The key includes
 * the target, so changing a server's port is not answered from the old one.
 */
export function createQueryCache(opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; value: Promise<ServerQuery> }>();

  return function cached(key: string, ask: () => Promise<ServerQuery>): Promise<ServerQuery> {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;

    // Sweep while we are here, so servers that were deleted or moved do not pile up.
    for (const [k, e] of entries) if (now() - e.at >= ttlMs) entries.delete(k);

    const value = ask();
    entries.set(key, { at: now(), value });
    // A rejection is not cached: the next caller asks again rather than being
    // handed the same failure for ten seconds. (`ask` normally resolves to
    // `unknown` instead of rejecting.)
    value.catch(() => entries.delete(key));
    return value;
  };
}
