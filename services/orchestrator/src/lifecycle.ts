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
    let deploymentId = String(payload.deploymentId ?? '');
    // A container created before #324 carries no deployment label, so a report
    // the agent saw by watching Docker (#332) names only the container.
    if (!deploymentId && payload.containerId) {
      const owner = (await repo.listDeployments()).find((d) => d.containerId === String(payload.containerId));
      deploymentId = owner?.id ?? '';
    }
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
        // As for a stop: news about a container the server has since replaced is
        // history (#332). A crash with no container — a failed start — always counts.
        const crashed = String(payload.containerId ?? '');
        const now = crashed ? await repo.getDeployment(deploymentId) : null;
        if (crashed && now?.containerId && now.containerId !== crashed) return;
        const reason = String(payload.reason ?? 'unknown');
        const updated = await repo.updateDeploymentStatus(deploymentId, {
          status: 'crashed',
          stoppedAt: new Date().toISOString(),
        });
        if (updated) await repo.appendDeploymentEvent(deploymentId, 'crashed', reason);
        return;
      }

      // The outcome of an image update (#239). A recreate also sends
      // server.started, which is what moves the container id; these only record
      // what happened, so the trail can say which version is running and why.
      case 'server.image-updated': {
        const digest = payload.digest ? String(payload.digest).slice(0, 19) : 'unknown digest';
        const recreated = payload.recreated === true;
        await repo.appendDeploymentEvent(
          deploymentId,
          'image-updated',
          `pulled ${String(payload.image ?? '')} (${digest})${recreated ? ' and recreated the container' : ' — applies on next start'}`,
        );
        return;
      }

      case 'server.update-failed': {
        await repo.appendDeploymentEvent(
          deploymentId,
          'update-failed',
          `could not pull ${String(payload.image ?? '')}: ${String(payload.reason ?? 'unknown')} — the server was left as it was`,
        );
        return;
      }

      default:
        return;
    }
  }

  return { handleReport };
}
