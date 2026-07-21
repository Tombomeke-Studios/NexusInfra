import { useCallback, useEffect, useState } from 'react';
import { listDeployments, stopDeployment, restartDeployment, type DeploymentView } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { DeploymentDrawer } from '../components/DeploymentDrawer';
import { IconStop, IconRestart } from '../components/Icons';
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const { toast } = useToast();

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

  return (
    <div className="page">
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
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id}>
                  <td>
                    <button className="name-btn" onClick={() => setDetailId(d.id)}>
                      {d.name}
                    </button>
                  </td>
                  <td className="mono">{d.dockerImage}</td>
                  <td>{d.nodeId ?? '—'}</td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="mono subtle">{shortId(d.containerId)}</td>
                  <td className="subtle tnum">{formatRelative(d.createdAt)}</td>
                  <td>
                    <span className="actions">
                      {d.status === 'running' && (
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
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailId && <DeploymentDrawer deploymentId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
