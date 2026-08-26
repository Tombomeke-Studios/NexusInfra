import { buildEnvelope, readPayload, type EventEnvelope, type NexusInfraEvent } from 'shared';
import type { DeploymentView, Repository } from './types.js';

// Reconciling what a node actually runs with what we think it runs (#244).
//
// The outbox (#167) keeps lifecycle reports from being lost when the *broker*
// goes away. It does nothing for the agent process itself dying: containers stop
// or keep running without anyone reporting it, the agent comes back with no
// memory, and the orchestrator's records quietly describe a machine that no
// longer matches. A server shown as running that is not is worse than one shown
// as crashed — nobody investigates a green light.
//
// So a returning agent reports what it can see, and this decides what that means.
// Pure: records in, decisions out, no clock and no I/O.

export interface ContainerState {
  containerId: string;
  running: boolean;
}

/** What a node reports about itself when its agent starts (#244). */
export interface NodeInventory {
  nodeId: string;
  containers: ContainerState[];
}

export type ReconcileAction =
  /** We thought it was running and the container is gone: say so. */
  | { type: 'mark-stopped'; deploymentId: string; reason: string }
  /** Gone, but the server asked to be kept alive, so start it again. */
  | { type: 'restart'; deploymentId: string; reason: string }
  /** It is running and we thought otherwise — adopt reality. */
  | { type: 'mark-running'; deploymentId: string; containerId: string; reason: string };

/**
 * What to do about a node's inventory.
 *
 * Deployments on other nodes are untouched: an inventory describes one machine,
 * and treating silence about a container as evidence it is gone would wipe out
 * every other node's state the moment one agent restarts.
 */
export function reconcileNode(deployments: DeploymentView[], inventory: NodeInventory): ReconcileAction[] {
  const here = deployments.filter((d) => d.nodeId === inventory.nodeId);
  const byId = new Map(inventory.containers.map((c) => [c.containerId, c]));
  const actions: ReconcileAction[] = [];

  for (const deployment of here) {
    const believedUp = deployment.status === 'running' || deployment.status === 'pending';
    const container = deployment.containerId ? byId.get(deployment.containerId) : undefined;
    const actuallyUp = Boolean(container?.running);

    if (believedUp && !actuallyUp) {
      // 'pending' means we asked for a container and never heard back — after an
      // agent restart that request is lost, so it is not coming.
      const reason =
        deployment.status === 'pending'
          ? 'the node restarted before this server was confirmed started'
          : 'the container is gone after the node agent restarted';

      actions.push(
        deployment.resourceLimits?.restartPolicy === 'always' || isAutoRestart(deployment)
          ? { type: 'restart', deploymentId: deployment.id, reason }
          : { type: 'mark-stopped', deploymentId: deployment.id, reason }
      );
      continue;
    }

    if (!believedUp && actuallyUp && container) {
      // Docker restarted it, or it was never really stopped. Adopting reality
      // beats insisting on a record — the container exists either way.
      actions.push({
        type: 'mark-running',
        deploymentId: deployment.id,
        containerId: container.containerId,
        reason: 'the container is running, though this server was recorded as stopped',
      });
    }
  }

  return actions;
}

/**
 * Whether this server asked to be kept alive.
 *
 * Treated as false when absent rather than guessed at: guessing here starts
 * containers nobody asked for.
 */
function isAutoRestart(deployment: DeploymentView): boolean {
  return deployment.autoRestart === true;
}


// ── Applying those decisions ──────────────────────────────────────────────────

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

export interface ReconcileDeps {
  repo: Repository;
  publish: PublishFn;
}

const KEY_START = 'infra.server.start';

/**
 * Consumes `infra.node.inventory` and makes the records match the machine (#244).
 *
 * Every correction is written to the audit trail (#223), because a server that
 * changes state without anybody asking is exactly the kind of thing someone will
 * later want explained.
 */
export function createReconcileHandler(deps: ReconcileDeps) {
  const { repo, publish } = deps;
  const emit = (routingKey: string, event: NexusInfraEvent) => publish(routingKey, buildEnvelope('orchestrator', event));

  return async function handleInventory(envelope: EventEnvelope): Promise<void> {
    if (envelope.event.type !== 'node.inventory') return;
    const payload = readPayload(envelope.event) as { nodeId?: string; containers?: { containerId: string; running: boolean }[] };
    if (!payload.nodeId) return;

    const inventory: NodeInventory = { nodeId: payload.nodeId, containers: payload.containers ?? [] };
    const deployments = await repo.listDeployments();

    for (const action of reconcileNode(deployments, inventory)) {
      switch (action.type) {
        case 'mark-stopped':
          await repo.updateDeploymentStatus(action.deploymentId, { status: 'stopped', containerId: null, stoppedAt: new Date().toISOString() });
          await repo.appendDeploymentEvent(action.deploymentId, 'reconciled-stopped', action.reason);
          break;

        case 'mark-running':
          await repo.updateDeploymentStatus(action.deploymentId, { status: 'running', containerId: action.containerId });
          await repo.appendDeploymentEvent(action.deploymentId, 'reconciled-running', action.reason);
          break;

        case 'restart': {
          const config = await repo.getDeploymentConfig(action.deploymentId);
          if (!config) break;
          await repo.updateDeploymentStatus(action.deploymentId, { status: 'pending', containerId: null });
          await repo.appendDeploymentEvent(action.deploymentId, 'reconciled-restart', action.reason);
          await emit(KEY_START, {
            type: 'server.start',
            payload: {
              deploymentId: action.deploymentId,
              nodeId: inventory.nodeId,
              dockerImage: config.dockerImage,
              containerName: config.name,
              env: config.env,
              ports: config.ports,
              resourceLimits: config.resourceLimits,
            },
          });
          break;
        }
      }
    }
  };
}
