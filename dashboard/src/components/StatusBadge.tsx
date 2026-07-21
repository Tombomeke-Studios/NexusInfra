import type { DeploymentStatus, NodeHealth } from '../api';

// One place that maps a status to a pill variant + label, so every page shows
// the same colour/text for the same state (colour is never the only signal).
type Status = DeploymentStatus | NodeHealth;

const VARIANT: Record<Status, string> = {
  running: 'success',
  healthy: 'success',
  pending: 'warning',
  degraded: 'warning',
  stopped: 'neutral',
  crashed: 'danger',
  failed: 'danger',
  offline: 'danger',
};

export function StatusBadge({ status }: { status: Status }) {
  const variant = VARIANT[status] ?? 'neutral';
  return (
    <span className={`badge badge--${variant}`}>
      <span className="badge__dot" />
      {status}
    </span>
  );
}
