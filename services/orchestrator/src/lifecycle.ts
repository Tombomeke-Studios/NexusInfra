import { readPayload, type EventEnvelope } from 'shared';
import type { Repository } from './types.js';

// Server lifecycle handling — the return half of the deployment loop. The Node
// Agent reports infra.server.started/stopped/crashed; here we update the matching
// deployment's status and append an audit event. Reports for unknown deployment
// ids are ignored (the update returns null).

export interface Lifecycle {
  handleReport(envelope: EventEnvelope): Promise<void>;
}

export function createLifecycle(repo: Repository): Lifecycle {
  async function handleReport(envelope: EventEnvelope): Promise<void> {
    const type = envelope.event.type;
    const payload = readPayload(envelope.event) as Record<string, unknown>;
    const deploymentId = String(payload.deploymentId ?? '');
    if (!deploymentId) return;

    switch (type) {
      case 'server.started': {
        const containerId = String(payload.containerId ?? '');
        const updated = await repo.updateDeploymentStatus(deploymentId, {
          status: 'running',
          containerId,
          nodeId: payload.nodeId ? String(payload.nodeId) : undefined,
          startedAt: new Date().toISOString(),
        });
        if (updated) await repo.appendDeploymentEvent(deploymentId, 'started', `container ${containerId} started`);
        return;
      }

      case 'server.stopped': {
        const updated = await repo.updateDeploymentStatus(deploymentId, {
          status: 'stopped',
          stoppedAt: new Date().toISOString(),
        });
        if (updated) await repo.appendDeploymentEvent(deploymentId, 'stopped', 'container stopped');
        return;
      }

      case 'server.crashed': {
        const reason = String(payload.reason ?? 'unknown');
        const updated = await repo.updateDeploymentStatus(deploymentId, {
          status: 'crashed',
          stoppedAt: new Date().toISOString(),
        });
        if (updated) await repo.appendDeploymentEvent(deploymentId, 'crashed', reason);
        return;
      }

      default:
        return;
    }
  }

  return { handleReport };
}
