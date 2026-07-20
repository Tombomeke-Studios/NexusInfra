import { buildEnvelope } from './events.js';
import { publishRabbitEvent } from './rabbitmq.js';

/**
 * Starts publishing a periodic service heartbeat on the shared event bus.
 *
 * Routing key: `monitoring.heartbeat.service.{name}` — the Control Room binds
 * `monitoring.heartbeat.#` and tracks each source's last-seen timestamp.
 *
 * Returns a stop function that clears the interval.
 */
export function startHeartbeat(name: string, intervalMs = 1000): () => void {
  const routingKey = `monitoring.heartbeat.service.${name}`;

  const beat = async () => {
    const envelope = buildEnvelope(name, {
      type: 'heartbeat.service',
      payload: { name, status: 'healthy', timestamp: new Date().toISOString() },
    });
    await publishRabbitEvent(routingKey, envelope);
  };

  // Emit immediately, then on the interval.
  void beat();
  const handle = setInterval(() => void beat(), intervalMs);

  return () => clearInterval(handle);
}
