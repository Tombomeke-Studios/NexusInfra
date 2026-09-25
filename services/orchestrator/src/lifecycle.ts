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
        // A report about a container this server no longer runs is history, not
        // news (#321): stop c1, start c2, and a replayed report for c1 (#167)
        // would otherwise mark c2 stopped.
        const reported = String(payload.containerId ?? '');
        const current = await repo.getDeployment(deploymentId);
        if (reported && current?.containerId && current.containerId !== reported) return;

        // The agent removes a container when it stops it (#52), so the id is
        // forgotten here — as reconciliation already does (#244). A stopped server
        // holding a stale id answered 202 to stop/restart and let file and console
        // routes through to a container that no longer existed.
        const updated = await repo.updateDeploymentStatus(deploymentId, {
          status: 'stopped',
          containerId: null,
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
