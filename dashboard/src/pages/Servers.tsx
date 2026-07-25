import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { listDeployments, stopDeployment, restartDeployment, startDeployment, type DeploymentView } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { IconStop, IconRestart, IconPlay } from '../components/Icons';
import { useToast } from '../components/Toast';
import { formatRelative, shortId } from '../format';

// Servers: the live list of deployments. It polls the Orchestrator so status
// transitions (pending → running → stopped/crashed) show up on their own, and
// offers a Stop action on running servers.
const POLL_MS = 3000;

export function Servers() {
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      setDeployments(await listDeployments());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load deployments');
    }
  }, []);

  useEffect(() => {
    void load();
    const handle = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(handle);
  }, [load]);

  const runAction = async (id: string, action: (id: string) => Promise<unknown>, verb: string) => {
    setPendingId(id);
    try {
      await action(id);
      toast(`Deployment ${verb} requested`, 'success');
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : `Failed to ${verb} deployment`;
      setError(message);
      toast(message, 'error');
    } finally {
      setPendingId(null);
    }
  };

  const onStop = (id: string) => runAction(id, stopDeployment, 'stop');
  const onRestart = (id: string) => runAction(id, restartDeployment, 'restart');
  const onStart = (id: string) => runAction(id, startDeployment, 'start');

  return (
    <div className="page" style={{ maxWidth: 1320 }}>
      <div className="page__head">
        <h1 className="page__title">Servers</h1>
        <span className="live">
          <span className="live__dot" />
          Live
        </span>
      </div>

      {error && (
        <p role="alert" className="alert alert--error" style={{ marginBottom: 'var(--space-4)' }}>
          {error}
        </p>
      )}

      {!deployments ? (
        <div className="table-wrap">
          <div className="empty">Loading…</div>
        </div>
      ) : deployments.length === 0 ? (
        <div className="table-wrap">
          <div className="empty">
            No deployments yet. Create one from <strong>New Deployment</strong>.
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Image</th>
                <th>Node</th>
                <th>Status</th>
                <th>Container</th>
                <th>Limits</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="stagger">
              {deployments.map((d, i) => (
                <tr key={d.id} style={{ ['--i']: Math.min(i, 12) } as CSSProperties}>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <button className="name-btn" onClick={() => navigate(`/servers/${d.id}`)}>
                        {d.name}
                      </button>
                      <span
                        style={{
                          fontSize: '.66rem',
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '.04em',
                          padding: '2px 7px',
                          borderRadius: 'var(--radius-full)',
                          background: 'var(--color-surface-2)',
                          color: 'var(--color-text-subtle)',
                        }}
                      >
                        {d.type === 'game' || d.dockerImage.startsWith('nexusinfra/') ? 'game' : 'app'}
                      </span>
                    </span>
                  </td>
                  <td className="mono">{d.dockerImage}</td>
                  <td>{d.nodeId ?? '—'}</td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="mono subtle">{shortId(d.containerId)}</td>
                  <td className="mono subtle" style={{ fontSize: '.82rem', whiteSpace: 'nowrap' }}>cpu 50% · ram 50%</td>
                  <td className="subtle tnum">{formatRelative(d.createdAt)}</td>
                  <td>
                    <span className="actions">
                      {d.status === 'running' ? (
                        <>
                          <button
                            className="btn btn--secondary btn--sm"
                            onClick={() => onRestart(d.id)}
                            disabled={pendingId === d.id}
                            aria-label={`Restart ${d.name}`}
                          >
                            <IconRestart size={15} />
                            Restart
                          </button>
                          <button
                            className="btn btn--danger btn--sm"
                            onClick={() => onStop(d.id)}
                            disabled={pendingId === d.id}
                            aria-label={`Stop ${d.name}`}
                          >
                            {pendingId === d.id ? <span className="spinner" /> : <IconStop size={15} />}
                            Stop
                          </button>
                        </>
                      ) : d.status === 'pending' ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--color-warning)', fontSize: '.82rem', fontWeight: 550 }}>
                          <span className="spinner" style={{ color: 'var(--color-warning)' }} />
                          placing…
                        </span>
                      ) : (
                        <button
                          className="btn btn--secondary btn--sm"
                          onClick={() => onStart(d.id)}
                          disabled={pendingId === d.id}
                          aria-label={`Start ${d.name}`}
                        >
                          {pendingId === d.id ? <span className="spinner" /> : <IconPlay size={15} />}
                          Start
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
