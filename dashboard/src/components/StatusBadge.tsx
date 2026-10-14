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

/**
 * `suspended` is a server billing stopped for lack of credit (#380) — still
 * stopped as far as the runtime goes, but not stopped by anyone who meant to.
 * `title` says why, for the hover.
 */
export function StatusBadge({ status, suspended = false, title }: { status: Status; suspended?: boolean; title?: string }) {
  const variant = suspended ? 'warning' : (VARIANT[status] ?? 'neutral');
  return (
    <span className={`badge badge--${variant}`} title={title}>
      <span className="badge__dot" />
      {suspended ? 'suspended' : status}
    </span>
  );
}
