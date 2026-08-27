import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { listNodes, listDeployments, deregisterNode, type NodeView, type DeploymentView } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { useDialog } from '../components/Dialog';

// Node detail (#125): a per-node view with live CPU/RAM meters, a session-scoped
// resource-history sparkline, the deployments hosted on it, and deregister. History
// isn't stored server-side, so we accumulate samples while the page is open.
const HISTORY = 60; // samples kept (~2 min at the 2s poll)

const cpuOf = (n: NodeView) => Math.round(n.cpuPercent ?? 0);
const ramOf = (n: NodeView) => (n.ramUsedMb != null && n.ramTotalMb ? Math.round((n.ramUsedMb / n.ramTotalMb) * 100) : 0);
// Null when the node cannot measure its disk — rendered as unknown, not 0% (#276).
const diskOf = (n: NodeView) => (n.diskUsedGb != null && n.diskTotalGb ? Math.round((n.diskUsedGb / n.diskTotalGb) * 100) : null);

export function NodeDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [node, setNode] = useState<NodeView | null>(null);
  const [deps, setDeps] = useState<DeploymentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const history = useRef<Array<{ cpu: number; ram: number }>>([]);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [nodes, deployments] = await Promise.all([listNodes(), listDeployments()]);
      const n = nodes.find((x) => x.id === id) ?? null;
      setNode(n);
      setDeps(deployments.filter((d) => d.nodeId === id));
      if (n) history.current = [...history.current, { cpu: cpuOf(n), ram: ramOf(n) }].slice(-HISTORY);
      setError(null);
      setLoaded(true);
      tick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setLoaded(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  const deregister = async () => {
    const ok = await confirm({
      title: `Deregister ${node?.name ?? id}?`,
      message: 'Its record is removed from the panel. The machine itself is untouched, and it will reappear if its agent keeps sending heartbeats.',
      confirmLabel: 'Deregister',
      danger: true,
    });
    if (!ok) return;
    try {
      await deregisterNode(id);
      toast('Node deregistered', 'error', 'Node');
      navigate('/');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Deregister failed', 'error', 'Node');
    }
  };

  if (error) return <div className="page"><p role="alert" className="alert alert--error">{error}</p></div>;
  if (!loaded) return <div className="page"><div className="empty">Loading…</div></div>;
  if (!node) return <div className="page"><div className="empty">Node not found.</div></div>;

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 24px 48px', animation: 'rise 300ms var(--ease-out) both' }}>
      <button className="btn btn--ghost btn--sm" data-ripple onClick={() => navigate('/')} style={{ marginBottom: 18 }}>← Overview</button>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1 style={{ fontSize: '1.5rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</h1>
            <StatusBadge status={node.health} />
          </div>
          <div className="mono" style={{ marginTop: 5, fontSize: '.85rem', color: 'var(--color-text-subtle)' }}>
            {node.id}{node.location ? ` · 📍 ${node.location}` : ''}
          </div>
        </div>
        <button className="btn btn--danger" data-ripple data-burst="danger" onClick={deregister}>Deregister</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 24 }}>
        <StatBox label="CPU" value={`${cpuOf(node)}%`} />
        <StatBox label="Memory" value={`${ramOf(node)}%`} />
        <StatBox label="Disk" value={diskOf(node) != null ? `${diskOf(node)}%` : '—'} />
        <StatBox label="Servers" value={String(deps.length)} />
      </div>

      <div className="card" style={{ padding: '18px 20px', marginBottom: 24 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 4 }}>Resource history</strong>
        <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.8rem' }}>Live since this page opened (CPU / memory %).</p>
        <Sparkline series={history.current} />
        <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: '.78rem' }}>
          <span style={{ color: 'var(--color-primary)' }}>● CPU {cpuOf(node)}%</span>
          <span style={{ color: 'var(--color-success)' }}>● Memory {ramOf(node)}%</span>
        </div>
      </div>

      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>Servers on this node</strong>
      <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', overflow: 'hidden' }}>
        {deps.map((d) => (
          <button
            key={d.id}
            data-ripple
            onClick={() => navigate(`/servers/${d.id}`)}
            style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text)', cursor: 'pointer', font: 'inherit' }}
          >
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: '.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
            <span className="mono subtle" style={{ fontSize: '.78rem' }}>{d.dockerImage}</span>
            <StatusBadge status={d.status} />
          </button>
        ))}
        {deps.length === 0 && <div className="empty">No servers on this node.</div>}
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '13px 16px' }}>
      <div style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-subtle)', marginBottom: 4 }}>{label}</div>
      <div className="tnum" style={{ fontSize: '1.3rem', fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// A tiny two-series (CPU/memory) sparkline over a 0–100 range, drawn as inline SVG.
function Sparkline({ series }: { series: Array<{ cpu: number; ram: number }> }) {
  const W = 600;
  const H = 90;
  if (series.length < 2) return <div className="empty" style={{ height: H }}>Collecting samples…</div>;
  const x = (i: number) => (i / (series.length - 1)) * W;
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const path = (key: 'cpu' | 'ram') => series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="CPU and memory history" style={{ width: '100%', height: H, display: 'block' }}>
      <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--color-border)" strokeWidth="1" strokeDasharray="4 4" />
      <path d={path('ram')} fill="none" stroke="var(--color-success)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <path d={path('cpu')} fill="none" stroke="var(--color-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
