import net from 'node:net';
import { WebSocket } from 'ws';
import { keepLinkAlive, LINK_NODE_HEADER, LinkSession, type LinkStream } from 'shared';

// The agent's half of the agent link (#416). A node behind NAT has no address
// the orchestrator can call, so the agent calls out instead: one WebSocket to
// the control plane, over which the orchestrator's requests come back as byte
// streams. Each stream is piped into this agent's own HTTP server on loopback —
// so the internal API, its token check and every route behave exactly as when
// they are called directly. The link opens nothing but that one port.

export interface LinkConfig {
  url: string;
  token: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Why a link URL may not be used, or null. Only `wss://`, bar loopback or an explicit lab opt-in. */
export function linkUrlProblem(raw: string, allowInsecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'AGENT_LINK_URL is not a URL';
  }
  if (url.protocol === 'wss:') return null;
  if (url.protocol !== 'ws:') return 'AGENT_LINK_URL must start with wss://';
  // The link carries the internal API token and every file and shell on the
  // node; in clear text it may only cross a machine's own loopback, or a lab
  // network somebody explicitly said was fine.
  if (LOOPBACK_HOSTS.has(url.hostname) || url.hostname.startsWith('127.') || allowInsecure) return null;
  return 'AGENT_LINK_URL must use wss:// (set AGENT_LINK_ALLOW_INSECURE=true to allow ws:// on a lab network)';
}

/**
 * The link settings from the environment: null when no link is configured (a
 * direct agent, as before), or the reason it cannot start.
 */
export function linkConfigFromEnv(env: NodeJS.ProcessEnv): LinkConfig | null | { problem: string } {
  const url = env.AGENT_LINK_URL?.trim();
  if (!url) return null;
  const problem = linkUrlProblem(url, env.AGENT_LINK_ALLOW_INSECURE === 'true');
  if (problem) return { problem };
  const token = env.AGENT_LINK_TOKEN?.trim();
  if (!token) return { problem: 'AGENT_LINK_URL is set but AGENT_LINK_TOKEN is not' };
  return { url, token };
}

export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;

/** The delay before the next reconnect: doubling from 1 s, never above 30 s. */
export function nextRetryMs(previous: number | null): number {
  if (previous === null) return FIRST_RETRY_MS;
  return Math.min(previous * 2, MAX_RETRY_MS);
}

export interface AgentLinkOptions extends LinkConfig {
  nodeId: string;
  /** The port this agent's own HTTP server listens on. */
  localPort: number;
  log?: (message: string) => void;
  /** For tests: how long to wait before the first retry. */
  firstRetryMs?: number;
}

export interface AgentLink {
  /** Whether the link is up right now. */
  readonly connected: boolean;
  stop(): void;
}

/** Pipe one stream from the control plane into the agent's own HTTP server. */
export function answerStream(stream: LinkStream, localPort: number): void {
  const local = net.connect({ host: '127.0.0.1', port: localPort });
  local.on('error', (err) => stream.destroy(err));
  stream.on('error', () => local.destroy());
  stream.on('close', () => local.destroy());
  local.on('close', () => stream.destroy());
  stream.pipe(local);
  local.pipe(stream);
}

/** Dial the control plane and keep the link up until `stop`. */
export function startAgentLink(options: AgentLinkOptions): AgentLink {
  const log = options.log ?? ((m: string) => console.log(m));
  let retry: number | null = null;
  let stopped = false;
  let connected = false;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (stopped) return;
    retry = retry === null && options.firstRetryMs !== undefined ? options.firstRetryMs : nextRetryMs(retry);
    timer = setTimeout(dial, retry);
  };

  function dial() {
    if (stopped) return;
    // The token rides in a header, never the URL — a URL ends up in logs.
    const ws = new WebSocket(options.url, {
      headers: { [LINK_NODE_HEADER]: options.nodeId, authorization: `Bearer ${options.token}` },
      handshakeTimeout: 10_000,
    });
    socket = ws;
    const session = new LinkSession(ws, { onOpen: (stream) => answerStream(stream, options.localPort) });
    let stopKeepAlive: (() => void) | null = null;

    ws.on('open', () => {
      connected = true;
      retry = null;
      stopKeepAlive = keepLinkAlive(ws);
      log(`[agent link] connected to ${new URL(options.url).host}`);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) session.receive(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
    });
    ws.on('unexpected-response', (_req, res) => {
      // 401 is a token the control plane does not know for this node: minted for
      // another one, or rotated since. Retrying keeps the node visible as trying.
      log(`[agent link] the control plane refused the link (${res.statusCode}); retrying`);
      ws.terminate();
    });
    ws.on('error', (err) => {
      if (!connected) log(`[agent link] could not connect: ${err.message}`);
    });
    ws.on('close', () => {
      if (connected) log('[agent link] disconnected; reconnecting');
      connected = false;
      stopKeepAlive?.();
      session.close('agent link closed');
      if (socket === ws) socket = null;
      schedule();
    });
  }

  dial();
  return {
    get connected() {
      return connected;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.terminate();
    },
  };
}
