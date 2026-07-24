import { useEffect, useState, type CSSProperties } from 'react';
import { listNodes, listDeployments, type NodeView, type DeploymentView } from '../api';
import { CountUp } from '../components/CountUp';
import { useToast } from '../components/Toast';
import { formatRelative } from '../format';

// Overview — ported from the redesign: stat cards, a fleet-utilization card, a
// grid of rich node cards (+ an add-node form, UI-only for now), and a recent
// activity feed. Real values come from the API; extras are derived/mock and get
// wired up later.
const meterColor = (pct: number) =>
  pct >= 85 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-primary)';

const healthStyle = (h: NodeView['health']) =>
  h === 'healthy'
    ? { color: 'var(--color-success)', soft: 'var(--color-success-soft)' }
    : h === 'degraded'
      ? { color: 'var(--color-warning)', soft: 'var(--color-warning-soft)' }
      : { color: 'var(--color-danger)', soft: 'var(--color-danger-soft)' };

export function Overview() {
  const [nodes, setNodes] = useState<NodeView[] | null>(null);
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingNode, setAddingNode] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    const load = (first: boolean) =>
      Promise.all([listNodes(), listDeployments()])
        .then(([n, d]) => {
          if (!alive) return;
          setNodes(n);
          setDeployments(d);
        })
        .catch((e) => alive && first && setError(e instanceof Error ? e.message : 'Failed to load'));
    void load(true);
    const t = setInterval(() => void load(false), 5000); // live meters
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const loading = !error && (!nodes || !deployments);
  const ns = nodes ?? [];
  const ds = deployments ?? [];
  const running = ds.filter((d) => d.status === 'running').length;
  const healthy = ns.filter((n) => n.health === 'healthy').length;
  const stats = [
    { label: 'Running servers', value: running },
    { label: 'Registered nodes', value: ns.length },
    { label: 'Healthy nodes', value: healthy },
    { label: 'Total deployments', value: ds.length },
  ];

  const cpuOf = (n: NodeView) => Math.round(n.cpuPercent ?? 0);
  const ramOf = (n: NodeView) => (n.ramUsedMb != null && n.ramTotalMb ? Math.round((n.ramUsedMb / n.ramTotalMb) * 100) : 0);
  const avgCpu = ns.length ? Math.round(ns.reduce((a, n) => a + cpuOf(n), 0) / ns.length) : 0;
  const avgRam = ns.length ? Math.round(ns.reduce((a, n) => a + ramOf(n), 0) / ns.length) : 0;

  const activity = ds
    .slice(0, 5)
    .map((d) => {
      const color =
        d.status === 'running'
          ? 'var(--color-success)'
          : d.status === 'crashed' || d.status === 'failed'
            ? 'var(--color-danger)'
            : 'var(--color-neutral)';
      return { id: d.id, color, text: `${d.name} is ${d.status}`, rel: formatRelative(d.createdAt) };
    });

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px', animation: 'rise 320ms var(--ease-out) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.4rem' }}>Overview</h1>
      </div>

      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{error}</p>}

      {/* Stat cards */}
      <div className="stagger" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        {loading
          ? [0, 1, 2, 3].map((i) => (
              <div key={i} className="card" style={{ flex: 1, minWidth: 168, padding: '18px 22px' }}>
                <div className="skeleton" style={{ height: 32, width: 48, marginBottom: 6 }} />
                <div className="skeleton" style={{ height: 14, width: '70%' }} />
              </div>
            ))
          : stats.map((s, i) => (
              <div
                key={s.label}
                className="card spotlight card--lift"
                data-spotlight
                style={{ ['--i']: i, flex: 1, minWidth: 168, padding: '18px 22px' } as CSSProperties}
              >
                <div className="tnum" style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '-.02em' }}>
                  <CountUp value={s.value} />
                </div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: '.9rem' }}>{s.label}</div>
              </div>
            ))}
      </div>

      {/* Fleet utilization */}
      <div className="card" style={{ padding: '20px 22px', marginBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
          <strong style={{ fontSize: '.98rem' }}>Fleet utilization</strong>
          <span style={{ fontSize: '.8rem', color: 'var(--color-text-subtle)' }}>averaged across {ns.length} nodes</span>
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'CPU', pct: avgCpu },
            { label: 'RAM', pct: avgRam },
          ].map((m) => (
            <div key={m.label} style={{ flex: 1, minWidth: 220 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: '.82rem', color: 'var(--color-text-muted)' }}>{m.label}</span>
                <span className="tnum" style={{ fontSize: '.82rem', fontWeight: 600 }}>{m.pct}%</span>
              </div>
              <div className="meter">
                <div className="meter__fill" style={{ width: `${m.pct}%`, background: meterColor(m.pct), transition: 'width 900ms var(--ease-out)' }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Nodes */}
      <h3 style={{ marginBottom: 16 }}>Nodes</h3>
      <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 16 }}>
        {ns.map((n, i) => {
          const hs = healthStyle(n.health);
          const cpu = cpuOf(n);
          const ram = ramOf(n);
          const svCount = ds.filter((d) => d.nodeId === n.id).length;
          const memGB = n.ramTotalMb ? Math.round(n.ramTotalMb / 1024) : 0;
          const cores = Math.max(1, Math.round((n.ramTotalMb ?? 4096) / 2048));
          const allocCpu = Math.min(100, svCount * 22);
          const allocRam = Math.min(100, svCount * 18);
          return (
            <article key={n.id} className="card node-card spotlight" data-spotlight style={{ ['--i']: i } as CSSProperties}>
              <div style={{ padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 8 }}>
                  <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</strong>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flex: 'none' }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 'var(--radius-full)',
                        fontSize: '.78rem',
                        fontWeight: 550,
                        textTransform: 'capitalize',
                        background: hs.soft,
                        color: hs.color,
                      }}
                    >
                      <span style={{ position: 'relative', width: 7, height: 7, borderRadius: '50%', background: 'currentColor' }}>
                        <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'currentColor', animation: 'ping 1.8s ease-out infinite' }} />
                      </span>
                      {n.health}
                    </span>
                    <button
                      className="icon-btn"
                      data-ripple
                      aria-label="Remove node"
                      onClick={() => toast('Removing nodes is not wired yet', 'info')}
                      style={{ width: 26, height: 26 }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: '.76rem', color: 'var(--color-text-subtle)', fontFamily: 'var(--font-mono)', marginBottom: 14 }}>
                  <span>{cores} vCPU</span><span>·</span><span>{memGB} GB</span><span>·</span><span>{svCount} servers</span>
                </div>
                <NodeMeter label="Live CPU" pct={cpu} />
                <NodeMeter label="Live RAM" pct={ram} />
                <div style={{ paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-subtle)' }}>Committed</span>
                    <span className="tnum mono" style={{ fontSize: '.76rem', color: 'var(--color-text-subtle)' }}>cpu {allocCpu}% · ram {allocRam}%</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <div className="meter" style={{ flex: 1, height: 5 }}><div className="meter__fill" style={{ width: `${allocCpu}%` }} /></div>
                    <div className="meter" style={{ flex: 1, height: 5 }}><div className="meter__fill" style={{ width: `${allocRam}%`, background: 'oklch(0.72 0.13 180)' }} /></div>
                  </div>
                </div>
                <button className="btn btn--secondary btn--sm" data-ripple style={{ marginTop: 14, width: '100%' }} onClick={() => toast('Maintenance mode is not wired yet', 'info')}>
                  Enter maintenance
                </button>
              </div>
            </article>
          );
        })}

        {!addingNode ? (
          <button className="node-add" data-ripple onClick={() => setAddingNode(true)}>
            <span style={{ fontSize: '1.6rem', lineHeight: 1, fontWeight: 300 }}>+</span>
            <span style={{ fontWeight: 600, fontSize: '.9rem' }}>New node</span>
          </button>
        ) : (
          <AddNodeForm onCancel={() => setAddingNode(false)} onCreate={() => { setAddingNode(false); toast('Adding nodes is not wired yet', 'info'); }} />
        )}
      </div>

      {/* Recent activity */}
      <h3 style={{ margin: '30px 0 16px' }}>Recent activity</h3>
      <div className="card" style={{ overflow: 'hidden', padding: 0 }}>
        {activity.length === 0 ? (
          <div className="empty">No recent activity.</div>
        ) : (
          activity.map((a) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--color-border)' }}>
              <span style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: a.color, boxShadow: `0 0 0 4px color-mix(in srgb, ${a.color} 18%, transparent)` }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: '.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.text}</span>
              <span className="tnum" style={{ flex: 'none', fontSize: '.8rem', color: 'var(--color-text-subtle)' }}>{a.rel}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NodeMeter({ label, pct }: { label: string; pct: number }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: '.78rem', color: 'var(--color-text-subtle)' }}>{label}</span>
        <span className="tnum" style={{ fontSize: '.78rem', color: 'var(--color-text-subtle)' }}>{pct}%</span>
      </div>
      <div className="meter" style={{ height: 6 }}>
        <div className="meter__fill" style={{ width: `${pct}%`, background: meterColor(pct), transition: 'width 900ms var(--ease-out)' }} />
      </div>
    </div>
  );
}

// Add-node form — UI only (create is a stub until node provisioning is wired).
function AddNodeForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: () => void }) {
  const [name, setName] = useState('');
  const [region, setRegion] = useState('fra');
  const [cores, setCores] = useState(8);
  const [mem, setMem] = useState(32);
  const [disk, setDisk] = useState(200);
  const [over, setOver] = useState(0);
  const [maint, setMaint] = useState(false);
  const numStyle: CSSProperties = { minHeight: 36 };

  return (
    <div style={{ border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', boxShadow: 'var(--shadow)', padding: 16, animation: 'pop 220ms var(--ease-out)' }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>New node</div>
      <input className="input" placeholder="node-fra-2 (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 10 }} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['fra', 'nyc', 'sgp', 'ams'].map((r) => (
          <button key={r} type="button" data-ripple onClick={() => setRegion(r)} className={`opt${region === r ? ' is-active' : ''}`} style={{ minHeight: 32, minWidth: 0, fontSize: '.76rem', textTransform: 'uppercase' }}>
            {r}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <label style={{ flex: 1, minWidth: 0 }}><span className="field__label" style={{ fontSize: '.76rem', color: 'var(--color-text-muted)' }}>vCPU cores</span><input className="input mono" type="number" min={1} max={128} value={cores} onChange={(e) => setCores(Number(e.target.value))} style={numStyle} /></label>
        <label style={{ flex: 1, minWidth: 0 }}><span className="field__label" style={{ fontSize: '.76rem', color: 'var(--color-text-muted)' }}>Memory (GB)</span><input className="input mono" type="number" min={1} max={1024} value={mem} onChange={(e) => setMem(Number(e.target.value))} style={numStyle} /></label>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <label style={{ flex: 1, minWidth: 0 }}><span className="field__label" style={{ fontSize: '.76rem', color: 'var(--color-text-muted)' }}>Disk (GB)</span><input className="input mono" type="number" min={10} max={10000} step={10} value={disk} onChange={(e) => setDisk(Number(e.target.value))} style={numStyle} /></label>
        <label style={{ flex: 1, minWidth: 0 }}><span className="field__label" style={{ fontSize: '.76rem', color: 'var(--color-text-muted)' }}>Mem overalloc %</span><input className="input mono" type="number" min={0} max={200} step={5} value={over} onChange={(e) => setOver(Number(e.target.value))} style={numStyle} /></label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14, padding: '9px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', cursor: 'pointer' }}>
        <span style={{ fontSize: '.82rem', fontWeight: 550 }}>Start in maintenance mode</span>
        <button type="button" role="switch" aria-checked={maint} aria-label="Start in maintenance" onClick={() => setMaint((v) => !v)} style={{ flex: 'none', width: 42, height: 24, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer', padding: 3, transition: 'background 200ms', background: maint ? 'var(--color-primary)' : 'var(--color-border-strong)' }}>
          <span style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'transform 200ms var(--ease-out)', transform: maint ? 'translateX(18px)' : 'translateX(0)' }} />
        </button>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="success" style={{ flex: 1 }} onClick={onCreate}>Create</button>
        <button className="btn btn--secondary btn--sm" data-ripple onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
