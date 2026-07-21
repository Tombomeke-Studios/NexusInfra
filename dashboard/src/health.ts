import type { NodeHealth, DeploymentStatus } from './api';

// Shared status → colour mapping so tiles, dots, and badges read consistently.
export function healthColor(health: NodeHealth): string {
  switch (health) {
    case 'healthy':
      return '#16a34a';
    case 'degraded':
      return '#d97706';
    case 'offline':
      return '#dc2626';
  }
}

export function deploymentColor(status: DeploymentStatus): string {
  switch (status) {
    case 'running':
      return '#16a34a';
    case 'pending':
      return '#d97706';
    case 'stopped':
      return '#64748b';
    case 'crashed':
    case 'failed':
      return '#dc2626';
  }
}
