import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

// The WebSocket half of the gateway (#69). An upgrade is proxied at the byte
// level: the handshake is replayed to the backend, the backend's 101 is relayed
// back, and from then on the two sockets are piped together. The gateway never
// parses a frame, so binary frames, pings and close codes arrive exactly as
// sent — the interactive terminal's resize and input messages included — and
// nothing here needs a WebSocket library.

/** Answer a handshake we will not proxy, then hang up. */
export function refuseUpgrade(socket: Duplex, status: number): void {
  const reason = http.STATUS_CODES[status] ?? 'Error';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Serialise a response head from raw header pairs, preserving repeats and case. */
export function responseHead(statusCode: number, statusMessage: string, rawHeaders: string[]): string {
  let head = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
  for (let i = 0; i < rawHeaders.length; i += 2) head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  return `${head}\r\n`;
}

// Headers that describe the client's hop to us, or that only we may set.
const STRIP = new Set(['host', 'x-forwarded-for', 'x-user-id']);

/** Replay an upgrade request to `target` and splice the two connections together. */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: string,
  extraHeaders: Record<string, string> = {}
): void {
  const url = new URL(req.url ?? '/', target);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP.has(k) && v !== undefined) headers[k] = v;
  }
  Object.assign(headers, extraHeaders);

  const transport = url.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(url, { method: req.method, headers });

  // Until the backend answers, a client that gives up must not leave the dial open.
  const abandon = () => upstreamReq.destroy();
  socket.once('close', abandon);
  socket.on('error', abandon);

  upstreamReq.on('upgrade', (res, upstream, upstreamHead) => {
    socket.off('close', abandon);
    socket.write(responseHead(res.statusCode ?? 101, res.statusMessage ?? 'Switching Protocols', res.rawHeaders));
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstream.write(head);

    // Either side ending ends both: a terminal whose shell exited must close the
    // browser's socket, and a closed tab must not keep a shell alive on the node.
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  // The backend answered without upgrading — a refusal. Relay its status so the
  // client learns why instead of seeing the connection simply drop.
  upstreamReq.on('response', (res) => {
    res.resume();
    refuseUpgrade(socket, res.statusCode ?? 502);
  });

  // The backend hung up on the handshake (the Orchestrator does exactly that for
  // a token or a server it will not honour) or could not be reached at all.
  upstreamReq.on('error', () => {
    if (!socket.destroyed) refuseUpgrade(socket, 502);
  });

  upstreamReq.end();
}
