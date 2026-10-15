import { buildEnvelope, type EventEnvelope } from 'shared';
import { startCommandFor } from './startCommand.js';
import type { Repository } from './types.js';

// Updating a server's image (#239): pull the tag afresh and, if the server is
// running, replace its container with one from the new image. One function for
// the API and the scheduler, so "update weekly" means exactly what the button does.
//
// It stays on the node it is on. An update is not a re-placement: the data is in
// that node's volumes (#324), and moving it is a different, admin-only operation.

export const KEY_UPDATE = 'infra.server.update';

export interface UpdateOutcome {
  status: number;
  body: { status?: string; deploymentId?: string; recreate?: boolean; error?: string };
}

export async function requestImageUpdate(
  deps: { repo: Repository; publish: (routingKey: string, envelope: EventEnvelope) => Promise<boolean> },
  deploymentId: string,
  requestedBy: 'user' | 'schedule',
): Promise<UpdateOutcome> {
  const { repo, publish } = deps;
  const detail = await repo.getDeployment(deploymentId);
  if (!detail) return { status: 404, body: { error: 'deployment not found' } };
  // Mid-placement there is no settled container to replace.
  if (detail.status === 'pending') return { status: 409, body: { error: 'deployment is starting — try again once it has settled' } };
  if (!detail.nodeId) return { status: 409, body: { error: 'deployment has no node to pull on' } };

  const config = await repo.getDeploymentConfig(deploymentId);
  if (!config) return { status: 404, body: { error: 'server config not found' } };

  const recreate = detail.status === 'running';
  await repo.appendDeploymentEvent(
    deploymentId,
    'update-requested',
    `image update requested by ${requestedBy}: pull ${config.dockerImage}${recreate ? ' and recreate the container' : ''}`,
  );
  await publish(
    KEY_UPDATE,
    buildEnvelope('orchestrator', { type: 'server.update', payload: { ...startCommandFor(config, deploymentId, detail.nodeId), recreate } }),
  );
  return { status: 202, body: { status: 'updating', deploymentId, recreate } };
}
