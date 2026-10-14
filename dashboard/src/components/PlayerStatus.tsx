import { useEffect, useState } from 'react';
import { getServerQuery, type ServerQuery } from '../api';
import { compactPlayers, describeQuery } from '../playerStatus';

// Who is on a game server, and whether the game answers at all (#382).
//
// Polls while the server runs. The orchestrator caches each answer for ten
// seconds, so several open tabs cost the game one packet, not one each.

const DETAIL_POLL_MS = 15_000;
const LIST_POLL_MS = 30_000;

function useServerQuery(deploymentId: string, running: boolean, everyMs: number): ServerQuery | null {
  const [query, setQuery] = useState<ServerQuery | null>(null);

  useEffect(() => {
    if (!running) {
      setQuery(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // A hidden tab has nobody looking; ask again when it is shown.
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const q = await getServerQuery(deploymentId);
          if (cancelled) return;
          setQuery(q);
          // Nothing to ask about this kind of server, and that will not change.
          if (q.status === 'unsupported') return;
        } catch {
          // A failed request is not a server with no players: keep the last
          // answer rather than replacing it with a guess.
          if (cancelled) return;
        }
      }
      timer = setTimeout(tick, everyMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [deploymentId, running, everyMs]);

  return query;
}

/** Under the server's name: players, MOTD, version, latency. */
export function PlayerStatus({ deploymentId, running }: { deploymentId: string; running: boolean }) {
  const d = describeQuery(useServerQuery(deploymentId, running, DETAIL_POLL_MS));
  if (!d) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8, fontSize: '.85rem' }} title={d.title}>
      <span className={`badge badge--${d.variant}`}>
        <span className="badge__dot" />
        {d.label}
      </span>
      {d.detail && <span className="subtle" style={{ overflowWrap: 'anywhere' }}>{d.detail}</span>}
    </div>
  );
}

/** The Servers list's form: "2/20 online", with the explanation on hover. */
export function PlayerCount({ deploymentId, running }: { deploymentId: string; running: boolean }) {
  const q = useServerQuery(deploymentId, running, LIST_POLL_MS);
  const text = compactPlayers(q);
  const d = describeQuery(q);
  if (!text || !d) return null;
  return (
    <div className="subtle tnum" style={{ fontSize: '.8rem', whiteSpace: 'nowrap', marginTop: 4 }} title={d.title}>
      {text}
    </div>
  );
}
