import { Router, type Request, type Response } from 'express';
import { buildEnvelope, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent } from 'shared';
import { nodeHealth } from './nodeRegistry.js';
import { selectNode as defaultSelectNode } from './nodeSelection.js';
import type { NodeRecord, Repository } from './types.js';

// Deployment REST API — the user-facing entry point that turns a server config
// into a running container. Creating a deployment picks a node and emits
// infra.server.start; the Node Agent runs the container and reports back (handled
// by lifecycle.ts). Auth is layered on separately (see auth.ts): handlers read the
// user id that middleware puts on the request, defaulting to a dev user locally.

const KEY_START = 'infra.server.start';
const KEY_STOP = 'infra.server.stop';

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
    const { name, dockerImage, ports, env, autoRestart, type } = req.body ?? {};
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

  router.get('/nodes', async (_req: Request, res: Response) => {
    const now = Date.now();
    const nodes = await repo.listNodes();
    res.json(nodes.map((n) => ({ ...n, health: nodeHealth(n, now) })));
  });

  return router;
}
