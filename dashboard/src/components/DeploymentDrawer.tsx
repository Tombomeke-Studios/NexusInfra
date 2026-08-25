import { useCallback, useEffect, useState } from 'react';
import { getDeployment, type DeploymentDetail } from '../api';
import { StatusBadge } from './StatusBadge';
import { formatRelative } from '../format';

// Right-side detail drawer for a deployment: metadata + the full event/audit
// trail (GET /deployments/:id). Closes on Escape, scrim click, or the button.
export function DeploymentDrawer({ deploymentId, onClose }: { deploymentId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<DeploymentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  // Play the exit animation before unmounting.
  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 170);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    getDeployment(deploymentId)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      alive = false;
    };
  }, [deploymentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <>
      <div className={`drawer__scrim${closing ? ' drawer__scrim--closing' : ''}`} onClick={close} />
      <aside
        className={`drawer__panel${closing ? ' drawer__panel--closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Deployment details"
      >
        <div className="drawer__head">
          <strong>{detail?.name ?? 'Deployment'}</strong>
          <button className="icon-btn" onClick={close} aria-label="Close details">
            ✕
          </button>
        </div>
        <div className="drawer__body">
          {error && <p role="alert" className="alert alert--error">{error}</p>}
          {!detail && !error ? (
            <>
              <div className="skeleton" style={{ height: 16, width: '70%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 16, width: '50%' }} />
            </>
          ) : detail ? (
            <>
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <StatusBadge status={detail.status} />
              </div>
              <dl className="meta">
                <dt>Image</dt>
                <dd className="mono">{detail.dockerImage}</dd>
                <dt>Node</dt>
                <dd>{detail.nodeId ?? '—'}</dd>
                <dt>Container</dt>
                <dd className="mono">{detail.containerId ?? '—'}</dd>
                <dt>Created</dt>
                <dd>{formatRelative(detail.createdAt)}</dd>
                <dt>Started</dt>
                <dd>{formatRelative(detail.startedAt)}</dd>
                <dt>Stopped</dt>
                <dd>{formatRelative(detail.stoppedAt)}</dd>
              </dl>

              <h3 style={{ fontSize: '0.95rem', marginBottom: 'var(--space-3)' }}>Event trail</h3>
              {detail.events.length === 0 ? (
                <p className="subtle">No events recorded.</p>
              ) : (
                <ul className="timeline">
                  {detail.events.map((e) => (
                    <li key={e.id}>
                      <div className="timeline__event">{e.event}</div>
                      <div className="muted" style={{ fontSize: '0.85rem' }}>{e.message}</div>
                      <div className="subtle tnum" style={{ fontSize: '0.78rem' }}>{formatRelative(e.timestamp)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
