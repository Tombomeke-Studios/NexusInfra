import { buildEnvelope, publishRabbitEvent, type EventEnvelope } from 'shared';
import type { Repository } from './types.js';

// Consumes billing.server.suspend from the Billing Bridge (hosted edition): when
// a user's credit runs out, stop each named deployment that is still running by
// emitting infra.server.stop, and record the suspension on the audit trail.
// Dependency-injected (publisher) so it's testable without a broker.

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

export interface SuspendDeps {
  repo: Repository;
  publish?: PublishFn;
}

export interface SuspendPayload {
  userId: string;
  deploymentIds: string[];
  reason: string;
}

export function createSuspendHandler(deps: SuspendDeps) {
  const { repo } = deps;
  const publish = deps.publish ?? publishRabbitEvent;

  return async function handleSuspend(payload: SuspendPayload): Promise<void> {
    for (const id of payload.deploymentIds ?? []) {
      const detail = await repo.getDeployment(id);
      if (!detail?.containerId || !detail.nodeId) continue; // already stopped/gone
      await publish(
        'infra.server.stop',
        buildEnvelope('orchestrator', {
          type: 'server.stop',
          payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
        })
      );
      await repo.appendDeploymentEvent(detail.id, 'suspended', `suspended by billing: ${payload.reason}`);
    }
  };
}
