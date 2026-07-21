// Small formatting helpers shared by pages.

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
