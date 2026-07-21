import { useEffect, useState } from 'react';
import { listNodes, listDeployments, type NodeView, type DeploymentView } from '../api';
import { StatusBadge } from '../components/StatusBadge';

// Overview: at-a-glance fleet health — running-server / node counts and a tile
// per node with its health and resource usage.
export function Overview() {
  const [nodes, setNodes] = useState<NodeView[] | null>(null);
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([listNodes(), listDeployments()])
      .then(([n, d]) => {
        if (!alive) return;
        setNodes(n);
        setDeployments(d);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      alive = false;
    };
  }, []);

  const loading = !error && (!nodes || !deployments);
  const running = deployments?.filter((d) => d.status === 'running').length ?? 0;

  return (
    <div className="page">
      <div className="page__head">
        <h1 className="page__title">Overview</h1>
      </div>

      {error && <p role="alert" className="alert alert--error">{error}</p>}

      <div className="row" style={{ marginBottom: 'var(--space-6)' }}>
        <Stat label="Running servers" value={running} loading={loading} />
        <Stat label="Registered nodes" value={nodes?.length ?? 0} loading={loading} />
      </div>

      <h3 style={{ marginBottom: 'var(--space-4)' }}>Nodes</h3>

      {loading ? (
        <div className="grid-cards">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card">
              <div className="card__body">
                <div className="skeleton" style={{ height: 18, width: '55%', marginBottom: 12 }} />
                <div className="skeleton" style={{ height: 6, marginBottom: 10 }} />
                <div className="skeleton" style={{ height: 6, width: '80%' }} />
              </div>
            </div>
          ))}
        </div>
      ) : nodes && nodes.length > 0 ? (
        <div className="grid-cards">
          {nodes.map((n) => (
            <NodeTile key={n.id} node={n} />
          ))}
        </div>
      ) : (
        !error && (
          <div className="card">
            <div className="empty">No nodes have reported in yet.</div>
          </div>
        )
      )}
    </div>
  );
}

function Stat({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <div className="stat" style={{ minWidth: 170 }}>
      {loading ? (
        <div className="skeleton" style={{ height: 32, width: 48, marginBottom: 6 }} />
      ) : (
        <div className="stat__value tnum">{value}</div>
      )}
      <div className="stat__label">{label}</div>
    </div>
  );
}

function NodeTile({ node }: { node: NodeView }) {
  const ramPct =
    node.ramUsedMb != null && node.ramTotalMb ? Math.round((node.ramUsedMb / node.ramTotalMb) * 100) : null;
  const cpuPct = node.cpuPercent != null ? Math.round(node.cpuPercent) : null;

  return (
    <article className="card">
      <div className="card__body">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
          <strong>{node.name}</strong>
          <StatusBadge status={node.health} />
        </div>
        <Meter label="CPU" pct={cpuPct} />
        <Meter label="RAM" pct={ramPct} />
      </div>
    </article>
  );
}

function Meter({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div style={{ marginBottom: 'var(--space-3)' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="subtle" style={{ fontSize: '0.8rem' }}>{label}</span>
        <span className="subtle tnum" style={{ fontSize: '0.8rem' }}>{pct != null ? `${pct}%` : '—'}</span>
      </div>
      <div className="meter">
        <div className="meter__fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}
