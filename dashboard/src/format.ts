// Small formatting helpers shared by pages.
import type { ResourceLimits } from './api';

/** Human relative time, e.g. "12s ago" / "3m ago" / "2h ago". */
export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Short container id (first 12 chars), or an em dash. */
export function shortId(id: string | null): string {
  return id ? id.slice(0, 12) : '—';
}

/** The caps a server was given, as a short line — or an em dash when it has none (#318). */
export function formatLimits(limits: ResourceLimits | undefined): string {
  if (!limits) return '—';
  const parts: string[] = [];
  // The absolute unit wins server-side when both are set (#275), so it wins here.
  if (typeof limits.cpuCores === 'number') parts.push(`cpu ${limits.cpuCores} core${limits.cpuCores === 1 ? '' : 's'}`);
  else if (typeof limits.cpuPercent === 'number') parts.push(`cpu ${limits.cpuPercent}%`);
  if (typeof limits.ramMb === 'number') parts.push(`ram ${limits.ramMb} MB`);
  else if (typeof limits.ramPercent === 'number') parts.push(`ram ${limits.ramPercent}%`);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Whether a server is a game server (#318).
 *
 * Since eggs (#231) a server's type is the egg it was made from, so "not a plain
 * application" is the test; `game` and the `nexusinfra/` image prefix are what
 * servers created before eggs carry.
 */
export function isGameServer(d: { type: string; dockerImage: string }): boolean {
  if (d.type === 'game' || d.dockerImage.startsWith('nexusinfra/')) return true;
  return Boolean(d.type) && d.type !== 'app' && d.type !== 'generic';
}
