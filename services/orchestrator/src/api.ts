import { Router, type Request, type Response } from 'express';
import { buildEnvelope, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent } from 'shared';
import { nodeHealth } from './nodeRegistry.js';
import { selectNode as defaultSelectNode } from './nodeSelection.js';
import type { DeploymentDetail, NodeRecord, Repository } from './types.js';

// Where the (single, local) Node Agent's internal HTTP lives. Multi-node will
// resolve this per node from the registry.
const NODE_AGENT_URL = process.env.NODE_AGENT_URL || 'http://node-agent:9100';

/** Decide whether a deployment's container can be streamed from, and which one. */
export function resolveContainerTarget(detail: DeploymentDetail | null): { status: number; error?: string; containerId?: string } {
  if (!detail) return { status: 404, error: 'deployment not found' };
  if (!detail.containerId) return { status: 409, error: 'deployment is not running' };
  return { status: 200, containerId: detail.containerId };
}

// Deployment REST API — the user-facing entry point that turns a server config
// into a running container. Creating a deployment picks a node and emits
// infra.server.start; the Node Agent runs the container and reports back (handled
// by lifecycle.ts). Auth is layered on separately (see auth.ts): handlers read the
// user id that middleware puts on the request, defaulting to a dev user locally.

const KEY_START = 'infra.server.start';
const KEY_STOP = 'infra.server.stop';
const KEY_RESTART = 'infra.server.restart';

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;
export type SelectNodeFn = (nodes: NodeRecord[], now: number) => NodeRecord | null;

export interface ApiDeps {
  repo: Repository;
  publish?: PublishFn;
  selectNode?: SelectNodeFn;
}

function userIdOf(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? 'dev-user';
}

export function createApiRouter(deps: ApiDeps): Router {
  const { repo } = deps;
  const publish = deps.publish ?? publishRabbitEvent;
  const selectNode = deps.selectNode ?? defaultSelectNode;
  const router = Router();

  const emit = (routingKey: string, event: NexusInfraEvent) =>
    publish(routingKey, buildEnvelope('orchestrator', event));

  // Create a deployment: persist config, place it on the least-loaded node, and
  // command the agent to start it.
  router.post('/deployments', async (req: Request, res: Response) => {
    const { name, dockerImage, ports, env, resourceLimits, autoRestart, type } = req.body ?? {};
    if (typeof name !== 'string' || typeof dockerImage !== 'string' || !name || !dockerImage) {
      return res.status(400).json({ error: 'name and dockerImage are required' });
    }

    const node = selectNode(await repo.listNodes(), Date.now());
    if (!node) {
      return res.status(503).json({ error: 'No healthy node available to place the deployment' });
    }

    const config = await repo.createServerConfig({
      userId: userIdOf(req),
      name,
      dockerImage,
      ports: ports ?? {},
      env: env ?? {},
      resourceLimits: resourceLimits && typeof resourceLimits === 'object' ? resourceLimits : {},
      autoRestart: Boolean(autoRestart),
      type: typeof type === 'string' ? type : 'generic',
    });
    const deployment = await repo.createDeployment(config.id, node.id);
    await repo.appendDeploymentEvent(deployment.id, 'created', `placed on node ${node.id}`);

    await emit('infra.deployment.created', { type: 'deployment.created', payload: { deploymentId: deployment.id, userId: config.userId } });
    await emit(KEY_START, {
      type: 'server.start',
      payload: {
        deploymentId: deployment.id,
        nodeId: node.id,
        dockerImage: config.dockerImage,
        containerName: config.name,
        env: config.env,
        ports: config.ports,
      },
    });

    const detail = await repo.getDeployment(deployment.id);
    return res.status(201).json(detail);
  });

  router.get('/deployments', async (_req: Request, res: Response) => {
    res.json(await repo.listDeployments());
  });

  router.get('/deployments/:id', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(detail);
  });

  // Request a running deployment be stopped: command the agent, which reports
  // server.stopped back (lifecycle.ts flips the status).
  router.post('/deployments/:id/stop', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId || !detail.nodeId) {
      return res.status(409).json({ error: 'deployment is not running' });
    }

    await repo.appendDeploymentEvent(detail.id, 'stop-requested', 'stop requested by user');
    await emit(KEY_STOP, {
      type: 'server.stop',
      payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
    });
    return res.status(202).json({ status: 'stopping', deploymentId: detail.id });
  });

  // Start (or re-run) a deployment that isn't currently running: re-place it on a
  // healthy node and command a fresh container from its saved config.
  router.post('/deployments/:id/start', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (detail.status === 'running' || detail.status === 'pending') {
      return res.status(409).json({ error: 'deployment is already running' });
    }
    const config = await repo.getDeploymentConfig(detail.id);
    if (!config) return res.status(404).json({ error: 'server config not found' });

    const node = selectNode(await repo.listNodes(), Date.now());
    if (!node) return res.status(503).json({ error: 'No healthy node available to place the deployment' });

    await repo.updateDeploymentStatus(detail.id, {
      status: 'pending',
      nodeId: node.id,
      containerId: null,
      startedAt: null,
      stoppedAt: null,
    });
    await repo.appendDeploymentEvent(detail.id, 'start-requested', `re-placed on node ${node.id}`);
    await emit(KEY_START, {
      type: 'server.start',
      payload: {
        deploymentId: detail.id,
        nodeId: node.id,
        dockerImage: config.dockerImage,
        containerName: config.name,
        env: config.env,
        ports: config.ports,
      },
    });
    return res.status(202).json({ status: 'starting', deploymentId: detail.id });
  });

  // Request a running deployment be restarted — the agent restarts the container
  // and reports server.started back.
  router.post('/deployments/:id/restart', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId || !detail.nodeId) {
      return res.status(409).json({ error: 'deployment is not running' });
    }

    await repo.appendDeploymentEvent(detail.id, 'restart-requested', 'restart requested by user');
    await emit(KEY_RESTART, {
      type: 'server.restart',
      payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
    });
    return res.status(202).json({ status: 'restarting', deploymentId: detail.id });
  });

  router.get('/nodes', async (_req: Request, res: Response) => {
    const now = Date.now();
    const nodes = await repo.listNodes();
    res.json(nodes.map((n) => ({ ...n, health: nodeHealth(n, now) })));
  });

  // Pipe an SSE stream from the owning Node Agent's internal `/{kind}/:containerId`
  // endpoint straight to the client, resolving the running container first.
  const proxyContainerStream = (kind: 'logs' | 'stats') => async (req: Request, res: Response) => {
    const target = resolveContainerTarget(await repo.getDeployment(req.params.id));
    if (target.status !== 200) return res.status(target.status).json({ error: target.error });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const upstream = await fetch(`${NODE_AGENT_URL}/${kind}/${target.containerId}`, { signal: controller.signal });
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // client disconnected or upstream closed
    }
    res.end();
  };

  // Stream a running deployment's logs / resource stats (SSE), proxied from the
  // owning Node Agent.
  router.get('/deployments/:id/logs', proxyContainerStream('logs'));
  router.get('/deployments/:id/stats', proxyContainerStream('stats'));

  return router;
}
