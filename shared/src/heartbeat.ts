import { buildEnvelope, type EventEnvelope, type NodeResources } from './events.js';
import { publishRabbitEvent } from './rabbitmq.js';

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

/**
 * Starts publishing a periodic service heartbeat on the shared event bus.
 *
 * Routing key: `monitoring.heartbeat.service.{name}` — the Control Room binds
 * `monitoring.heartbeat.#` and tracks each source's last-seen timestamp.
 *
 * `publish` is injectable for testing; it defaults to the real RabbitMQ publisher.
 * Returns a stop function that clears the interval.
 */
export function startHeartbeat(name: string, intervalMs = 1000, publish: PublishFn = publishRabbitEvent): () => void {
  const routingKey = `monitoring.heartbeat.service.${name}`;

  const beat = async () => {
    const envelope = buildEnvelope(name, {
      type: 'heartbeat.service',
      payload: { name, status: 'healthy', timestamp: new Date().toISOString() },
    });
    await publish(routingKey, envelope);
  };

  void beat();
  const handle = setInterval(() => void beat(), intervalMs);
  return () => clearInterval(handle);
}

export interface NodeHeartbeatOptions {
  /** Liveness pulse cadence. */
  beatMs?: number;
  /** How often the pulse carries a fresh resource snapshot (should be a multiple of beatMs). */
  resourceMs?: number;
  /** Injectable publisher for testing; defaults to the real RabbitMQ publisher. */
  publish?: PublishFn;
}

/**
 * Starts publishing a periodic node heartbeat on `monitoring.heartbeat.node.{nodeId}`.
 *
 * Every `beatMs` a lightweight liveness pulse is sent; every `resourceMs` the pulse
 * additionally carries a CPU/RAM/disk snapshot from `collectResources`. Splitting the
 * cadences keeps liveness cheap while honouring the roadmap's 5s resource-report interval.
 *
 * Returns a stop function that clears the interval.
 */
export function startNodeHeartbeat(
  nodeId: string,
  collectResources: () => Promise<NodeResources>,
  options: NodeHeartbeatOptions = {}
): () => void {
  const beatMs = options.beatMs ?? 1000;
  const resourceMs = options.resourceMs ?? 5000;
  const publish = options.publish ?? publishRabbitEvent;
  const routingKey = `monitoring.heartbeat.node.${nodeId}`;

  let elapsed = 0;

  const beat = async (withResources: boolean) => {
    const resources = withResources ? await collectResources() : undefined;
    const envelope = buildEnvelope(`node-agent:${nodeId}`, {
      type: 'heartbeat.node',
      payload: { nodeId, status: 'healthy', timestamp: new Date().toISOString(), resources },
    });
    await publish(routingKey, envelope);
  };

  // First pulse carries resources so the Control Room sees capacity immediately.
  void beat(true);
  const handle = setInterval(() => {
    elapsed += beatMs;
    void beat(elapsed % resourceMs === 0);
  }, beatMs);

  return () => clearInterval(handle);
}
