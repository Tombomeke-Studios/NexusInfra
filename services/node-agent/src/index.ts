import os from 'os';
import express from 'express';
import { consumeRabbitQueue, startNodeHeartbeat } from 'shared';
import { DockerodeRuntime } from './runtime.js';
import { createAgent } from './agent.js';
import { createFileRouter } from './fileRoutes.js';
import { createDatabaseRouter } from './dbRoutes.js';

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

app.listen(PORT, () => console.log(`[Node Agent ${NODE_ID}] HTTP listening on http://localhost:${PORT}`));

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
