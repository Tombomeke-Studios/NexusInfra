import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getCurrentUser,
  listDeployments,
  stopDeployment,
  restartDeployment,
  startDeployment,
  type CurrentUser,
  type DeploymentView,
} from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { IconStop, IconRestart, IconPlay } from '../components/Icons';
import { useToast } from '../components/Toast';
import { formatRelative, shortId } from '../format';
import { can, ROLE_LABELS, type ServerRole } from '../permissions';

// Servers: the live list of deployments. It polls the Orchestrator so status
// transitions (pending → running → stopped/crashed) show up on their own.
//
// The list is split into servers you own and servers shared with you (#178),
// because once other people's servers appear here "which of these are mine" is
// the first question. Control actions are gated on the role the API returns with
// each row, so the panel doesn't offer a button that would come back 403.
const POLL_MS = 3000;

interface ServerActions {
  stop: (id: string) => void;
  restart: (id: string) => void;
  start: (id: string) => void;
}

export function Servers() {
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null);
  const [me, setMe] = useState<CurrentUser | null>(null);
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
    void getCurrentUser()
      .then(setMe)
      .catch(() => undefined);
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

  const actions: ServerActions = {
    stop: (id) => void runAction(id, stopDeployment, 'stop'),
    restart: (id) => void runAction(id, restartDeployment, 'restart'),
    start: (id) => void runAction(id, startDeployment, 'start'),
  };

  // Ownership comes from the record, not from the role: a platform administrator
  // resolves to `owner` on every server, and calling all of them "mine" would be
  // misleading.
  const owned = deployments?.filter((d) => !me || !d.userId || d.userId === me.id) ?? [];
  const shared = deployments?.filter((d) => me && d.userId && d.userId !== me.id) ?? [];

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
        <>
          {/* Headings only earn their space once there is a second section. */}
          {shared.length > 0 && <h2 style={{ fontSize: '1rem', margin: '0 0 10px' }}>My servers</h2>}
          {owned.length > 0 ? (
            <ServerTable rows={owned} pendingId={pendingId} actions={actions} navigate={navigate} />
          ) : (
            <div className="table-wrap">
              <div className="empty">
                You don&apos;t own any servers yet — create one from <strong>New Deployment</strong>.
              </div>
            </div>
          )}

          {shared.length > 0 && (
            <>
              <h2 style={{ fontSize: '1rem', margin: '26px 0 10px' }}>
                Shared with me
                <span className="subtle" style={{ fontWeight: 400, fontSize: '.82rem', marginLeft: 8 }}>
                  Servers other people have given you access to
                </span>
              </h2>
              <ServerTable rows={shared} pendingId={pendingId} actions={actions} navigate={navigate} showRole />
            </>
          )}
        </>
      )}
    </div>
  );
}

function ServerTable({
  rows,
  pendingId,
  actions,
  navigate,
  showRole = false,
}: {
  rows: DeploymentView[];
  pendingId: string | null;
  actions: ServerActions;
  navigate: (to: string) => void;
  showRole?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Image</th>
            <th>Node</th>
            <th>Status</th>
            {showRole && <th>Your role</th>}
            <th>Container</th>
            <th>Limits</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="stagger">
          {rows.map((d, i) => {
            const role = d.role as ServerRole | undefined;
            const busy = pendingId === d.id;
            return (
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
                {showRole && <td className="subtle">{role ? ROLE_LABELS[role] : '—'}</td>}
                <td className="mono subtle">{shortId(d.containerId)}</td>
                <td className="mono subtle" style={{ fontSize: '.82rem', whiteSpace: 'nowrap' }}>
                  cpu 50% · ram 50%
                </td>
                <td className="subtle tnum">{formatRelative(d.createdAt)}</td>
                <td>
                  <span className="actions">
                    {d.status === 'running' ? (
                      <>
                        {can(role, 'control.restart') && (
                          <button className="btn btn--secondary btn--sm" onClick={() => actions.restart(d.id)} disabled={busy} aria-label={`Restart ${d.name}`}>
                            <IconRestart size={15} />
                            Restart
                          </button>
                        )}
                        {can(role, 'control.stop') && (
                          <button className="btn btn--danger btn--sm" onClick={() => actions.stop(d.id)} disabled={busy} aria-label={`Stop ${d.name}`}>
                            {busy ? <span className="spinner" /> : <IconStop size={15} />}
                            Stop
                          </button>
                        )}
                        {/* A viewer sees the state but no controls, rather than
                            buttons that would come back refused. */}
                        {!can(role, 'control.stop') && !can(role, 'control.restart') && (
                          <span className="subtle" style={{ fontSize: '.82rem' }}>View only</span>
                        )}
                      </>
                    ) : d.status === 'pending' ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--color-warning)', fontSize: '.82rem', fontWeight: 550 }}>
                        <span className="spinner" style={{ color: 'var(--color-warning)' }} />
                        placing…
                      </span>
                    ) : can(role, 'control.start') ? (
                      <button className="btn btn--secondary btn--sm" onClick={() => actions.start(d.id)} disabled={busy} aria-label={`Start ${d.name}`}>
                        {busy ? <span className="spinner" /> : <IconPlay size={15} />}
                        Start
                      </button>
                    ) : (
                      <span className="subtle" style={{ fontSize: '.82rem' }}>View only</span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
