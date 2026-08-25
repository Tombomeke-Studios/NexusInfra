// WebSocket proxy plumbing for the interactive terminal (#71/#69). The dashboard
// opens a WS to the Orchestrator, which (after JWT auth + resolving the owning
// container) opens a WS to the Node Agent and pipes the two together. The piping
// is a pure function of the two socket interfaces, so it's unit-testable with
// fakes; the real `ws` sockets are adapted at the edge (index.ts).

export interface DuplexSocket {
  on(event: 'message', cb: (data: string) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

/** Wire two sockets together: each side's messages go to the other; either close ends both. */
export function pipeSockets(a: DuplexSocket, b: DuplexSocket): void {
  a.on('message', (data) => b.send(data));
  b.on('message', (data) => a.send(data));
  a.on('close', () => b.close());
  b.on('close', () => a.close());
}

/** Derive the Node Agent's WS base from its HTTP URL (http→ws, https→wss). */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}
