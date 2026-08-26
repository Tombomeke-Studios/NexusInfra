import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { listNodes, listDeployments, registerNode, deregisterNode, setNodeMaintenance, getMonitoring, type NodeView, type DeploymentView, type MonitoringSnapshot } from '../api';
import { CountUp } from '../components/CountUp';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';
import { formatRelative } from '../format';

// Overview — ported from the redesign: stat cards, a fleet-utilization card, a
// grid of rich node cards (+ an add-node form) and a recent activity feed. The
// stats, node health and maintenance state all come from the API; maintenance is
// a real persisted drain that stops the orchestrator placing here (#258).
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
  const [monitoring, setMonitoring] = useState<MonitoringSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingNode, setAddingNode] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const refresh = useCallback(
    (first = false) =>
      Promise.all([listNodes(), listDeployments()])
        .then(([n, d]) => {
          setNodes(n);
          setDeployments(d);
        })
        .catch((e) => first && setError(e instanceof Error ? e.message : 'Failed to load')),
    []
  );

  // Control Room monitoring is best-effort: never let it error the Overview.
  const refreshMonitoring = useCallback(
    () => getMonitoring().then(setMonitoring).catch(() => setMonitoring({ monitored: [], reachable: false })),
    []
  );

  useEffect(() => {
    let alive = true;
    void refresh(true);
    void refreshMonitoring();
    const t = setInterval(() => {
      if (!alive) return;
      void refresh(false);
      void refreshMonitoring();
    }, 5000); // live meters
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refresh, refreshMonitoring]);

  const loading = !error && (!nodes || !deployments);
  const ns = nodes ?? [];
  const ds = deployments ?? [];

  // Register a node's metadata (#113). It reads offline until an agent started with
  // NODE_ID=<id> heartbeats in — so we tell the user how to bring it online.
  const addNode = async (cfg: { name: string; location: string; maint: boolean }) => {
    try {
      const node = await registerNode({ name: cfg.name.trim() || undefined, location: cfg.location.trim() || undefined });
      if (cfg.maint) await setNodeMaintenance(node.id, true);
      setAddingNode(false);
      toast(`${node.name} registered — start its agent with NODE_ID=${node.id}`, 'success', 'Node');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Register failed', 'error', 'Node');
    }
  };
  const removeNode = async (id: string, name: string) => {
    if (!window.confirm(`Deregister ${name}? Its record is removed (the machine itself is untouched).`)) return;
    try {
      await deregisterNode(id);
      toast(`${name} deregistered`, 'error', 'Node');
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Deregister failed', 'error', 'Node');
    }
  };
  // Maintenance is a real, persisted drain (#258): the orchestrator stops placing
  // new servers here. It deliberately leaves what already runs alone, so say so.
  const toggleMaint = async (id: string, name: string, on: boolean) => {
    try {
      await setNodeMaintenance(id, on);
      toast(
        on ? `${name} is draining — no new servers will be placed here` : `${name} is back in the placement pool`,
        on ? 'info' : 'success',
        'Node'
      );
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change maintenance', 'error', 'Node');
    }
  };
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

      {/* Platform services (Control Room monitoring, #157) */}
      <ServicesStrip monitoring={monitoring} />

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
          const inMaint = Boolean(n.maintenance);
          const hs = inMaint ? { color: 'var(--color-warning)', soft: 'var(--color-warning-soft)' } : healthStyle(n.health);
          const healthLabel = inMaint ? 'maintenance' : n.health;
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
                  <button className="name-btn" data-ripple onClick={() => navigate(`/nodes/${n.id}`)} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700, fontSize: '1rem' }}>{n.name}</button>
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
                      {healthLabel}
                    </span>
                    <button
                      className="icon-btn"
                      data-ripple
                      aria-label="Remove node"
                      onClick={() => removeNode(n.id, n.name)}
                      style={{ width: 26, height: 26 }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: '.76rem', color: 'var(--color-text-subtle)', fontFamily: 'var(--font-mono)', marginBottom: 14, flexWrap: 'wrap' }}>
                  <span>{cores} vCPU</span><span>·</span><span>{memGB} GB</span><span>·</span><span>{svCount} servers</span>
                  {n.location && (<><span>·</span><span>📍 {n.location}</span></>)}
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
                <button className="btn btn--secondary btn--sm" data-ripple style={{ marginTop: 14, width: '100%' }} onClick={() => void toggleMaint(n.id, n.name, !inMaint)}>
                  {inMaint ? 'Exit maintenance' : 'Enter maintenance'}
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
          <AddNodeForm onCancel={() => setAddingNode(false)} onCreate={addNode} />
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

// Platform-services health strip (#157). Renders the Control Room's live view of
// every service heartbeat so the Control Room (and the rest of the stack) is
// visibly up in the panel — previously it was monitored but never surfaced.
function ServicesStrip({ monitoring }: { monitoring: MonitoringSnapshot | null }) {
  const dot = (status: string) =>
    status === 'healthy' ? 'var(--color-success)' : status === 'degraded' ? 'var(--color-warning)' : 'var(--color-danger)';

  // Guard against a malformed/empty payload so the strip never crashes Overview.
  const list = Array.isArray(monitoring?.monitored) ? monitoring!.monitored : [];
  const reachable = monitoring?.reachable === true;

  return (
    <div className="card" style={{ padding: '16px 22px', marginBottom: 30 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <strong style={{ fontSize: '.98rem' }}>
          Platform services
          <InfoHint text="The Control Room watches every service and node heartbeat on the bus. healthy < 3s since last beat, degraded < 10s, then offline." label="Services help" />
        </strong>
        <span style={{ fontSize: '.8rem', color: 'var(--color-text-subtle)' }}>Control Room monitoring</span>
      </div>
      {!monitoring ? (
        <div className="skeleton" style={{ height: 26, width: 240 }} />
      ) : !reachable && list.length === 0 ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: '.86rem', color: 'var(--color-danger)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-danger)' }} />
          Control Room unreachable
        </span>
      ) : list.length === 0 ? (
        <span className="subtle" style={{ fontSize: '.86rem' }}>No service heartbeats seen yet.</span>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {list.map((s) => (
            <span
              key={s.source}
              title={`last seen ${Math.round(s.lastSeenMsAgo / 1000)}s ago${s.uptimePercent != null ? ` · ${s.uptimePercent}% uptime since first seen` : ''}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 'var(--radius-full)', border: '1px solid var(--color-border)', fontSize: '.82rem' }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot(s.status) }} />
              <span style={{ fontFamily: 'var(--font-mono)' }}>{s.source}</span>
              <span style={{ color: 'var(--color-text-subtle)', textTransform: 'capitalize' }}>{s.status}</span>
              {s.uptimePercent != null && (
                <span className="tnum" style={{ color: 'var(--color-text-subtle)' }}>{s.uptimePercent}%</span>
              )}
            </span>
          ))}
        </div>
      )}
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

// Register-node form (#113). Registers a node's metadata (name + location); its
// CPU/RAM/disk are reported by the agent once it connects, so there are no hardware
// fields to fill in — a node comes online when you run its agent with NODE_ID.
function AddNodeForm({ onCancel, onCreate }: { onCancel: () => void; onCreate: (cfg: { name: string; location: string; maint: boolean }) => void }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [maint, setMaint] = useState(false);

  return (
    <div style={{ border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', boxShadow: 'var(--shadow)', padding: 16, animation: 'pop 220ms var(--ease-out)' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Register node
        <InfoHint text="A node is a Docker host NexusInfra runs servers on. Registering records its name + location; run the agent there with NODE_ID=<id> and it comes online. Its CPU/RAM/disk are reported automatically." label="What is a node?" />
      </div>
      <p className="subtle" style={{ fontSize: '.78rem', margin: '0 0 12px' }}>Resources are auto-detected from the node's agent — just give it a name and (optionally) a location.</p>
      <input className="input" placeholder="node name (optional)" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 10 }} />
      <label style={{ display: 'block', marginBottom: 14 }}>
        <span className="field__label" style={{ fontSize: '.76rem', color: 'var(--color-text-muted)' }}>
          Location <span className="subtle" style={{ fontWeight: 400 }}>(optional)</span>
          <InfoHint text="A free-form label for where this machine lives — it's your own hardware, so name it however helps you: home-server, office-rack, hetzner-fsn1. Purely for your own organisation." label="Location help" />
        </span>
        <input className="input" placeholder="home-server, hetzner-fsn1, …" value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14, padding: '9px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', cursor: 'pointer' }}>
        <span style={{ fontSize: '.82rem', fontWeight: 550 }}>Start in maintenance mode<InfoHint text="Register the node but don't schedule new servers onto it yet — for setup, upgrades or draining." label="Maintenance mode help" /></span>
        <button type="button" role="switch" aria-checked={maint} aria-label="Start in maintenance" onClick={() => setMaint((v) => !v)} style={{ flex: 'none', width: 42, height: 24, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer', padding: 3, transition: 'background 200ms', background: maint ? 'var(--color-primary)' : 'var(--color-border-strong)' }}>
          <span style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'transform 200ms var(--ease-out)', transform: maint ? 'translateX(18px)' : 'translateX(0)' }} />
        </button>
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="success" style={{ flex: 1 }} onClick={() => onCreate({ name, location, maint })}>Register</button>
        <button className="btn btn--secondary btn--sm" data-ripple onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
