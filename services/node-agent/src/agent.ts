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
const KEY_IMAGE_UPDATED = 'infra.server.image-updated';
const KEY_UPDATE_FAILED = 'infra.server.update-failed';
const KEY_INVENTORY = 'infra.node.inventory';

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
  /**
   * How long to let a container settle after it dies before looking at it
   * (#332) — long enough for the agent's own removal, or a restart policy, to
   * have happened. Zero in tests.
   */
  settleMs?: number;
}

/** A Docker event for a container this agent manages (#332). */
export interface ContainerEvent {
  action: 'die' | 'start';
  containerId: string;
  /** From the container's label; null for containers created before #324. */
  deploymentId: string | null;
  exitCode?: number;
}

export interface NodeAgent {
  handleCommand(envelope: EventEnvelope): Promise<void>;
  /**
   * React to a container stopping or starting without being asked (#332). The
   * agent used to report only the outcome of its own commands, so a container
   * that died on its own — a crash, the OOM killer, `docker kill` — stayed
   * "running" in the panel indefinitely.
   */
  handleContainerEvent(event: ContainerEvent): Promise<void>;
  /**
   * Report what this node is actually running (#244).
   *
   * Called once at startup. A crashed agent comes back with no memory of what it
   * was doing, so rather than guess, it says what Docker can see and lets the
   * orchestrator reconcile that against its records.
   */
  reportInventory(): Promise<void>;
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
  const settleMs = deps.settleMs ?? 1500;

  // Containers the agent is restarting itself, so their stop is not a crash.
  // Marked for the duration of the restart plus a short grace for the event to
  // arrive — a longer window would swallow a real crash that follows it.
  const ownRestarts = new Map<string, number>();
  const OWN_GRACE_MS = 5_000;
  const markOwn = (containerId: string) => ownRestarts.set(containerId, Number.POSITIVE_INFINITY);
  const releaseOwn = (containerId: string) => ownRestarts.set(containerId, Date.now() + OWN_GRACE_MS);
  const isOwn = (containerId: string) => {
    const until = ownRestarts.get(containerId);
    if (until === undefined) return false;
    if (until < Date.now()) {
      ownRestarts.delete(containerId);
      return false;
    }
    return true;
  };
  // Containers reported down by the watcher, so a later start is news.
  const reportedDown = new Set<string>();

  const emit = (routingKey: string, event: NexusInfraEvent) =>
    publish(routingKey, buildEnvelope(source, event));

  /**
   * The runtime spec for a start command, shared by server.start and the recreate
   * half of server.update (#239).
   *
   * An import path is re-resolved here even though the orchestrator already asked
   * this node to check it (#268). The orchestrator cannot see this filesystem,
   * the event travels over a broker, and the failure mode is handing someone a
   * root shell over the host — so the node that will perform the mount is the
   * one that decides it is allowed.
   */
  async function startSpecFrom(payload: Record<string, unknown>, deploymentId: string): Promise<StartSpec> {
    const spec: StartSpec = {
      dockerImage: String(payload.dockerImage),
      containerName: payload.containerName as string | undefined,
      env: payload.env as Record<string, string> | undefined,
      ports: payload.ports as Record<string, string> | undefined,
      resourceLimits: payload.resourceLimits as ResourceLimits | undefined,
      // Names and labels this server's data volumes, so they outlive the
      // container (#324).
      deploymentId,
      persistPaths: Array.isArray(payload.persistPaths) ? (payload.persistPaths as unknown[]).map(String) : [],
    };
    const mount = payload.dataMount as { hostPath: string; containerPath: string } | undefined;
    if (mount) {
      spec.dataMount = { hostPath: await resolveMount(String(mount.hostPath)), containerPath: String(mount.containerPath) };
    }
    return spec;
  }

  async function handleCommand(envelope: EventEnvelope): Promise<void> {
    const type = envelope.event.type;
    const payload = readPayload(envelope.event) as Record<string, unknown>;

    // Ignore commands not addressed to this node.
    if (payload.nodeId && payload.nodeId !== nodeId) return;

    const deploymentId = String(payload.deploymentId ?? '');

    switch (type) {
      case 'server.start': {
        try {
          const spec = await startSpecFrom(payload, deploymentId);
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

      case 'server.update': {
        // Pull first, recreate second (#239): a registry that is down, or a tag
        // that no longer exists, must leave a running server exactly as it was.
        const image = String(payload.dockerImage);
        let pulled: { imageId: string; digest: string | null };
        try {
          pulled = await runtime.pullImage(image);
        } catch (err) {
          await emit(KEY_UPDATE_FAILED, { type: 'server.update-failed', payload: { deploymentId, image, reason: errMessage(err) } });
          return;
        }

        const recreate = payload.recreate === true;
        if (recreate) {
          // The same start as server.start — it replaces the same-named container,
          // and the data volumes (#324) are mounted again on the new one.
          try {
            const containerId = await runtime.start(await startSpecFrom(payload, deploymentId));
            await emit(KEY_STARTED, { type: 'server.started', payload: { deploymentId, containerId, nodeId } });
          } catch (err) {
            await emit(KEY_CRASHED, { type: 'server.crashed', payload: { deploymentId, containerId: '', reason: errMessage(err) } });
            return;
          }
        }
        await emit(KEY_IMAGE_UPDATED, {
          type: 'server.image-updated',
          payload: { deploymentId, image, digest: pulled.digest, recreated: recreate },
        });
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
        markOwn(containerId);
        try {
          await runtime.restart(containerId).finally(() => releaseOwn(containerId));
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

  async function reportInventory(): Promise<void> {
    try {
      const containers = await runtime.listManaged();
      await emit(KEY_INVENTORY, { type: 'node.inventory', payload: { nodeId, containers } });
    } catch (err) {
      // Never fatal: an agent that cannot introspect must still serve commands.
      console.error(`[node-agent] could not report inventory: ${errMessage(err)}`);
    }
  }

  async function handleContainerEvent(event: ContainerEvent): Promise<void> {
    const { containerId } = event;
    const deploymentId = event.deploymentId ?? '';

    if (event.action === 'start') {
      // Only news when we said it was down: every start the agent makes itself
      // is already reported by the command that made it.
      if (!reportedDown.delete(containerId)) return;
      await emit(KEY_STARTED, { type: 'server.started', payload: { deploymentId, containerId, nodeId } });
      return;
    }

    if (isOwn(containerId)) return;
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

    const state = await runtime.inspectContainer(containerId);
    // Gone: the agent removed it — a stop, a kill, a recreate, a delete.
    if (!state) return;
    if (isOwn(containerId)) return;

    const exitCode = event.exitCode ?? state.exitCode;
    const why = `exited with code ${exitCode}${state.oomKilled ? ' — killed by the OOM killer: it ran out of memory for its limit' : ''}`;

    if (state.running) {
      // Its restart policy already brought it back. A crash still happened and
      // is still worth knowing about; a clean exit is a stop, not a crash.
      if (exitCode === 0 && !state.oomKilled) {
        await emit(KEY_STOPPED, { type: 'server.stopped', payload: { deploymentId, containerId } });
      } else {
        await emit(KEY_CRASHED, { type: 'server.crashed', payload: { deploymentId, containerId, reason: `${why}, and was restarted by its restart policy` } });
      }
      await emit(KEY_STARTED, { type: 'server.started', payload: { deploymentId, containerId, nodeId } });
      return;
    }

    reportedDown.add(containerId);
    if (exitCode === 0 && !state.oomKilled) {
      await emit(KEY_STOPPED, { type: 'server.stopped', payload: { deploymentId, containerId } });
    } else {
      await emit(KEY_CRASHED, { type: 'server.crashed', payload: { deploymentId, containerId, reason: why } });
    }
  }

  return { handleCommand, handleContainerEvent, reportInventory };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
