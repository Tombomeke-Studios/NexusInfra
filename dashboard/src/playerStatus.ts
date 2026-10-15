import type { ServerQuery } from './api';

// How a game server's own status reads in the panel (#382). Pure, so the
// wording — and above all what is *not* claimed — is unit-tested.

export interface QueryDescription {
  /** The short line: "2 / 20 players", "Not answering". */
  label: string;
  /** A badge variant from components.css. */
  variant: 'success' | 'warning' | 'neutral';
  /** What the game said besides the count: MOTD, version, map, latency. */
  detail: string | null;
  /** The longer explanation, for a tooltip. */
  title: string;
}

/**
 * Null when there is nothing worth showing: a stopped server already says so in
 * its status badge, and a kind of server we cannot ask has nothing to say.
 */
export function describeQuery(q: ServerQuery | null): QueryDescription | null {
  if (!q) return null;
  switch (q.status) {
    case 'online': {
      const parts = [q.motd ?? q.name, q.version, q.map && q.map !== (q.motd ?? q.name) ? q.map : null].filter(Boolean) as string[];
      if (q.latencyMs != null) parts.push(`${q.latencyMs} ms`);
      const label = q.players ? `${q.players.online} / ${q.players.max} players` : 'Answering';
      return {
        label,
        variant: 'success',
        detail: parts.length ? parts.join(' · ') : null,
        title: q.players
          ? `The game answered: ${q.players.online} of ${q.players.max} slots taken.`
          : 'The game answered, but does not share its player count.',
      };
    }
    case 'offline':
      return {
        label: 'Not answering',
        variant: 'warning',
        detail: null,
        title: `The container runs, but the game did not answer its status query${q.error ? ` (${q.error})` : ''}. It may still be starting, or players cannot reach it either.`,
      };
    case 'unknown':
      return {
        label: 'Players unknown',
        variant: 'neutral',
        detail: null,
        title: `The node could not be asked${q.error ? `: ${q.error}` : ''}.`,
      };
    default:
      return null;
  }
}

/**
 * The compact form for a table cell: "2/20 online", or the label when there is
 * no count. Words rather than a bare fraction, so it reads the same aloud.
 */
export function compactPlayers(q: ServerQuery | null): string | null {
  const d = describeQuery(q);
  if (!d || !q) return null;
  if (q.status === 'online' && q.players) return `${q.players.online}/${q.players.max} online`;
  return d.label;
}
