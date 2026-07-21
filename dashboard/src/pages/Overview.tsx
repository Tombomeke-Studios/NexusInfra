import { useEffect, useState } from 'react';
import { listNodes, listDeployments, type NodeView, type DeploymentView } from '../api';
import { healthColor } from '../health';

// Overview: at-a-glance fleet health — one tile per registered node plus a count
// of currently running servers.
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

  if (error) return <p role="alert" style={{ color: '#dc2626', padding: '1.5rem' }}>{error}</p>;
  if (!nodes || !deployments) return <p style={{ padding: '1.5rem' }}>Loading…</p>;

  const running = deployments.filter((d) => d.status === 'running').length;

  return (
    <section style={{ padding: '1.5rem' }}>
      <h2>Overview</h2>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <Stat label="Running servers" value={running} />
        <Stat label="Registered nodes" value={nodes.length} />
      </div>

      <h3>Nodes</h3>
      {nodes.length === 0 ? (
        <p style={{ color: '#64748b' }}>No nodes have reported in yet.</p>
      ) : (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {nodes.map((n) => (
            <article
              key={n.id}
              style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem', minWidth: 200 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span
                  aria-hidden
                  style={{ width: 10, height: 10, borderRadius: '50%', background: healthColor(n.health) }}
                />
                <strong>{n.name}</strong>
              </div>
              <p style={{ margin: '0.5rem 0 0', color: '#64748b', fontSize: '0.9rem' }}>
                {n.health}
                {n.cpuPercent != null && <> · CPU {Math.round(n.cpuPercent)}%</>}
                {n.ramUsedMb != null && n.ramTotalMb ? (
                  <> · RAM {Math.round((n.ramUsedMb / n.ramTotalMb) * 100)}%</>
                ) : null}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '1rem 1.5rem', minWidth: 160 }}>
      <div style={{ fontSize: '2rem', fontWeight: 700 }}>{value}</div>
      <div style={{ color: '#64748b' }}>{label}</div>
    </div>
  );
}
