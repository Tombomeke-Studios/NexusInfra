import os from 'os';
import { createServer } from 'http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { consumeRabbitQueue, startNodeHeartbeat } from 'shared';
import { DockerodeRuntime } from './runtime.js';
import { createAgent } from './agent.js';
import { createFileRouter } from './fileRoutes.js';
import { createDatabaseRouter } from './dbRoutes.js';
import { createBackupRouter } from './bkRoutes.js';
import { createExecRouter } from './execRoutes.js';
import { attachTerminal, type TerminalSocket } from './terminal.js';

// ── Node Agent ────────────────────────────────────────────────────────────────
// Runs on a Docker host. Consumes server lifecycle commands addressed to this
// node and drives the local Docker daemon via dockerode (see runtime.ts).

const NODE_ID = process.env.NODE_ID || `node-${os.hostname()}`;
const PORT = Number(process.env.PORT) || 9100;

const runtime = new DockerodeRuntime();
const agent = createAgent({ nodeId: NODE_ID, runtime });

// ── HTTP: health probe ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '4mb' })); // file writes carry content in the body
app.get('/health', (_req, res) => {
  res.json({ service: 'node-agent', nodeId: NODE_ID, status: 'healthy', uptimeSec: Math.round(process.uptime()) });
});

// ── HTTP: container log stream (SSE) ──────────────────────────────────────────
// Internal endpoint (reached only via the Orchestrator's proxy on the private
// network) that follows a container's logs and emits one SSE `data:` per line.
app.get('/logs/:containerId', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const stop = runtime.logs(req.params.containerId, (line) => res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`));
  req.on('close', () => stop());
});

// ── HTTP: container resource stats stream (SSE) ───────────────────────────────
// Internal endpoint (reached only via the Orchestrator's proxy) that follows a
// container's Docker stats and emits one SSE `data:` per JSON stats sample.
app.get('/stats/:containerId', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const stop = runtime.stats(req.params.containerId, (stats) => res.write(`data: ${JSON.stringify(stats)}\n\n`));
  req.on('close', () => stop());
});

// ── HTTP: container file management (#108) ────────────────────────────────────
// Internal CRUD over the container's filesystem, reached only via the proxy.
app.use(createFileRouter(runtime));

// ── HTTP: managed database provisioning (#109) ────────────────────────────────
app.use(createDatabaseRouter(runtime));

// ── HTTP: backups (#110) — tar snapshot/restore of a container path ───────────
app.use(createBackupRouter(runtime));

// ── HTTP: console (#68) — one-shot command exec in a container ────────────────
app.use(createExecRouter(runtime));

// ── WebSocket: interactive terminal (#71) ─────────────────────────────────────
// Internal WS endpoint (reached only via the Orchestrator's WS proxy) that opens
// a TTY shell in the container and bridges it to the socket. Path:
// /terminal/:containerId?cols=&rows=.
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

/** Adapt a `ws` socket to the minimal TerminalSocket the bridge expects. */
function toTerminalSocket(ws: WebSocket): TerminalSocket {
  return {
    on(event, cb) {
      if (event === 'message') ws.on('message', (data: Buffer) => (cb as (d: string) => void)(data.toString('utf8')));
      else ws.on('close', cb as () => void);
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', 'http://node-agent');
  const match = /^\/terminal\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;
    const session = runtime.execInteractive(match[1], { cols, rows });
    attachTerminal(toTerminalSocket(ws), session);
  });
});

server.listen(PORT, () => console.log(`[Node Agent ${NODE_ID}] HTTP listening on http://localhost:${PORT}`));

// ── Event bus: consume server lifecycle commands ──────────────────────────────
async function start() {
  try {
    await consumeRabbitQueue(
      `nexusinfra.node-agent.${NODE_ID}`,
      ['infra.server.start', 'infra.server.stop', 'infra.server.restart'],
      (envelope) => agent.handleCommand(envelope)
    );
    console.log(`[Node Agent ${NODE_ID}] Listening for server commands`);

    // 1s liveness pulse; CPU/RAM/disk snapshot every 5s. Control Room monitors it.
    startNodeHeartbeat(NODE_ID, () => runtime.collectResources());
    console.log(`[Node Agent ${NODE_ID}] Publishing heartbeat on monitoring.heartbeat.node.${NODE_ID}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Node Agent ${NODE_ID}] Failed to connect to event bus:`, message);
    console.error(`[Node Agent ${NODE_ID}] HTTP health remains available; set RABBITMQ_URL to enable commands.`);
  }
}

void start();

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
