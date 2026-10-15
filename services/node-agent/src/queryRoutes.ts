import net from 'net';
import dgram from 'dgram';
import { lookup as dnsLookup } from 'dns/promises';
import { Router, type Request, type Response } from 'express';
import {
  a2sInfoRequest,
  bedrockPing,
  isQueryProtocol,
  minecraftStatusRequest,
  parseA2sResponse,
  parseBedrockPong,
  parseMinecraftStatus,
  readMinecraftStatusFrame,
  type GameStatus,
  type QueryProtocol,
} from './query.js';

// Asking a game server how it is doing (#382) — the sockets.
//
// The agent asks because it is on the same host as the published port; the
// orchestrator may be on another machine entirely, and the game's port may not
// be reachable from there at all.
//
// A server that does not answer is `offline`, with the reason. It is never a
// server with zero players: "nobody is on" and "nobody can get on" are the two
// answers this feature exists to tell apart.

/** How long one question may take. A game server answers in milliseconds or not at all. */
export const DEFAULT_QUERY_TIMEOUT_MS = 2_500;

export interface ProbeResult {
  status: GameStatus;
  latencyMs: number;
}

export type Probe = (host: string, port: number, timeoutMs: number) => Promise<ProbeResult>;

const elapsed = (since: bigint) => Math.max(0, Math.round(Number(process.hrtime.bigint() - since) / 1e6));

/** Minecraft Java: Server List Ping over TCP. */
export const queryMinecraft: Probe = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let sentAt = process.hrtime.bigint();
    let done = false;
    const socket = net.connect({ host, port });
    const finish = (err: Error | null, result?: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    // A deadline for the whole exchange, not an idle timeout: a server that
    // trickles a byte at a time must not hold the question open indefinitely.
    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    socket.on('error', (err) => finish(err));
    socket.on('connect', () => {
      sentAt = process.hrtime.bigint();
      socket.write(minecraftStatusRequest(host, port));
    });
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      try {
        const json = readMinecraftStatusFrame(received);
        if (json !== null) finish(null, { status: parseMinecraftStatus(json), latencyMs: elapsed(sentAt) });
      } catch (err) {
        finish(err as Error);
      }
    });
    socket.on('end', () => finish(new Error('the server closed the connection without a status')));
  });

/**
 * Send datagrams and wait for answers until `onMessage` returns a result. One
 * socket, one deadline for the whole exchange — including A2S's challenge round.
 */
function udpExchange<T>(
  host: string,
  port: number,
  timeoutMs: number,
  first: Buffer,
  onMessage: (msg: Buffer, send: (b: Buffer) => void) => T | undefined
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    let done = false;
    const finish = (err: Error | null, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    const send = (b: Buffer) => socket.send(b, port, host, (err) => err && finish(err));
    socket.on('error', (err) => finish(err));
    socket.on('message', (msg) => {
      try {
        const value = onMessage(msg, send);
        if (value !== undefined) finish(null, value);
      } catch (err) {
        finish(err as Error);
      }
    });
    send(first);
  });
}

/** Minecraft Bedrock: RakNet unconnected ping over UDP. */
export const queryBedrock: Probe = (host, port, timeoutMs) => {
  const sentAt = process.hrtime.bigint();
  const guid = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  return udpExchange(host, port, timeoutMs, bedrockPing(BigInt(Date.now()), guid), (msg) => ({
    status: parseBedrockPong(msg),
    latencyMs: elapsed(sentAt),
  }));
};

/** How many challenges to answer before deciding the server is just bouncing us. */
const MAX_CHALLENGES = 3;

/** Steam: A2S_INFO over UDP, answering the challenge when the server asks for one. */
export const queryA2s: Probe = (host, port, timeoutMs) => {
  let sentAt = process.hrtime.bigint();
  let challenges = 0;
  return udpExchange(host, port, timeoutMs, a2sInfoRequest(), (msg, send) => {
    const response = parseA2sResponse(msg);
    if (response.kind === 'challenge') {
      if (++challenges > MAX_CHALLENGES) throw new Error('the server kept answering with a new challenge');
      // The latency that matters is the round trip that produced the info.
      sentAt = process.hrtime.bigint();
      send(a2sInfoRequest(response.challenge));
      return undefined;
    }
    return { status: response.status, latencyMs: elapsed(sentAt) };
  });
};

export const PROBES: Record<QueryProtocol, Probe> = {
  minecraft: queryMinecraft,
  bedrock: queryBedrock,
  a2s: queryA2s,
};

/**
 * Where the published ports are reachable from this process.
 *
 * In a container, `127.0.0.1` is the agent's own network namespace, not the
 * host's — the game's published port is not there. The bundles map
 * `host.docker.internal` to the host gateway, so that name is tried first;
 * an agent run directly on a host has no such name and uses loopback.
 * `QUERY_HOST` overrides both.
 */
export async function resolveQueryHost(
  env: NodeJS.ProcessEnv = process.env,
  lookup: (name: string) => Promise<unknown> = (name) => dnsLookup(name)
): Promise<string> {
  const explicit = env.QUERY_HOST?.trim();
  if (explicit) return explicit;
  try {
    await lookup('host.docker.internal');
    return 'host.docker.internal';
  } catch {
    return '127.0.0.1';
  }
}

export type QueryAnswer =
  | ({ status: 'online'; protocol: QueryProtocol; latencyMs: number } & GameStatus)
  | { status: 'offline'; protocol: QueryProtocol; error: string };

export interface QueryRouterDeps {
  /** Resolved once and reused; see `resolveQueryHost`. */
  host: () => Promise<string>;
  probes?: Record<QueryProtocol, Probe>;
  timeoutMs?: number;
}

export function createQueryRouter(deps: QueryRouterDeps): Router {
  const router = Router();
  const probes = deps.probes ?? PROBES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  // GET /query?protocol=a2s&port=2457 — the port is the *host* port, as published.
  router.get('/query', async (req: Request, res: Response) => {
    const protocol = req.query.protocol;
    if (!isQueryProtocol(protocol)) return res.status(400).json({ error: 'protocol must be minecraft, bedrock or a2s' });
    const port = Number(req.query.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'port must be 1-65535' });

    try {
      const { status, latencyMs } = await probes[protocol](await deps.host(), port, timeoutMs);
      const answer: QueryAnswer = { status: 'online', protocol, latencyMs, ...status };
      return res.json(answer);
    } catch (err) {
      // Not an error of this endpoint: the question was asked and the game did
      // not answer it, which is exactly what the caller wants to know.
      const answer: QueryAnswer = { status: 'offline', protocol, error: err instanceof Error ? err.message : String(err) };
      return res.json(answer);
    }
  });

  return router;
}
