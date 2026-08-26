import {
  buildEnvelope,
  readPayload,
  publishRabbitEvent,
  type EventEnvelope,
  type NexusInfraEvent,
} from 'shared';
import type { ResourceLimits } from 'shared';
import type { ContainerRuntime, StartSpec } from './runtime.js';
import { importRoot, resolveImportPath } from './imports.js';

// Routing keys for lifecycle reports the agent publishes. Command keys the agent
// consumes (infra.server.start/stop/restart) are bound in index.ts.
const KEY_STARTED = 'infra.server.started';
const KEY_STOPPED = 'infra.server.stopped';
const KEY_CRASHED = 'infra.server.crashed';

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

export interface AgentDeps {
  nodeId: string;
  runtime: ContainerRuntime;
  /** Injectable so tests can capture events without a live broker. */
  publish?: PublishFn;
  /**
   * Resolves an import directory against this node's allowlist (#268). Injected so
   * the escape cases are testable without touching a real filesystem; the default
   * uses fs.realpath and IMPORT_ROOT.
   */
  resolveMount?: (hostPath: string) => Promise<string>;
}

export interface NodeAgent {
  handleCommand(envelope: EventEnvelope): Promise<void>;
}

/**
 * Creates a Node Agent. `handleCommand` reacts to server.start/stop/restart
 * commands addressed to this node, drives the container runtime, and publishes
 * the matching lifecycle report (or server.crashed on failure).
 *
 * Commands for other nodes are ignored — every agent sees every command on its
 * own queue and filters by `nodeId` in the payload.
 */
export function createAgent(deps: AgentDeps): NodeAgent {
  const { nodeId, runtime } = deps;
  const publish = deps.publish ?? publishRabbitEvent;
  const resolveMount =
    deps.resolveMount ??
    (async (hostPath: string) => {
      const { realpath } = await import('fs/promises');
      return resolveImportPath(hostPath, { root: importRoot(), realpath });
    });
  const source = `node-agent:${nodeId}`;

  const emit = (routingKey: string, event: NexusInfraEvent) =>
    publish(routingKey, buildEnvelope(source, event));

  async function handleCommand(envelope: EventEnvelope): Promise<void> {
    const type = envelope.event.type;
    const payload = readPayload(envelope.event) as Record<string, unknown>;

    // Ignore commands not addressed to this node.
    if (payload.nodeId && payload.nodeId !== nodeId) return;

    const deploymentId = String(payload.deploymentId ?? '');

    switch (type) {
      case 'server.start': {
        const spec: StartSpec = {
          dockerImage: String(payload.dockerImage),
          containerName: payload.containerName as string | undefined,
          env: payload.env as Record<string, string> | undefined,
          ports: payload.ports as Record<string, string> | undefined,
          resourceLimits: payload.resourceLimits as ResourceLimits | undefined,
        };
        try {
          // An import path is re-resolved here even though the orchestrator
          // already asked this node to check it (#268). The orchestrator cannot
          // see this filesystem, the event travels over a broker, and the failure
          // mode is handing someone a root shell over the host — so the node that
          // will perform the mount is the one that decides it is allowed.
          const mount = payload.dataMount as { hostPath: string; containerPath: string } | undefined;
          if (mount) {
            spec.dataMount = { hostPath: await resolveMount(String(mount.hostPath)), containerPath: String(mount.containerPath) };
          }
          const containerId = await runtime.start(spec);
          await emit(KEY_STARTED, {
            type: 'server.started',
            payload: { deploymentId, containerId, nodeId },
          });
        } catch (err) {
          await emit(KEY_CRASHED, {
            type: 'server.crashed',
            payload: { deploymentId, containerId: '', reason: errMessage(err) },
          });
        }
        return;
      }

      case 'server.stop': {
        const containerId = String(payload.containerId ?? '');
        try {
          await runtime.stop(containerId);
          await emit(KEY_STOPPED, {
            type: 'server.stopped',
            payload: { deploymentId, containerId },
          });
        } catch (err) {
          await emit(KEY_CRASHED, {
            type: 'server.crashed',
            payload: { deploymentId, containerId, reason: errMessage(err) },
          });
        }
        return;
      }

      // Force-terminate a container that will not stop gracefully (#253). The
      // report is the same server.stopped — from the orchestrator's point of view
      // the outcome is identical; how it got there is in the audit trail.
      case 'server.kill': {
        const containerId = String(payload.containerId ?? '');
        try {
          await runtime.kill(containerId);
          await emit(KEY_STOPPED, {
            type: 'server.stopped',
            payload: { deploymentId, containerId },
          });
        } catch (err) {
          await emit(KEY_CRASHED, {
            type: 'server.crashed',
            payload: { deploymentId, containerId, reason: errMessage(err) },
          });
        }
        return;
      }

      case 'server.restart': {
        const containerId = String(payload.containerId ?? '');
        try {
          await runtime.restart(containerId);
          await emit(KEY_STARTED, {
            type: 'server.started',
            payload: { deploymentId, containerId, nodeId },
          });
        } catch (err) {
          await emit(KEY_CRASHED, {
            type: 'server.crashed',
            payload: { deploymentId, containerId, reason: errMessage(err) },
          });
        }
        return;
      }

      default:
        // Not a command this agent handles.
        return;
    }
  }

  return { handleCommand };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
