import { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDeployment, listNodes, type NodeView } from '../api';
import { IconPlus } from '../components/Icons';
import { useToast } from '../components/Toast';

// New Deployment — ported from the redesign. The real deploy sends name, image,
// ports and env; the richer controls (type, game form, placement, resource
// limits, runtime, feature limits) are UI for now and wired up later.
interface Row {
  key: string;
  value: string;
}
const rowsToRecord = (rows: Row[]) => {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value.trim();
  return out;
};
const limitColor = (v: number) => (v >= 85 ? 'var(--color-danger)' : v >= 65 ? 'var(--color-warning)' : 'var(--color-primary)');

export function NewDeployment() {
  const [kind, setKind] = useState<'app' | 'game'>('app');
  const [name, setName] = useState('');
  const [dockerImage, setDockerImage] = useState('');
  const [game, setGame] = useState('minecraft');
  const [ports, setPorts] = useState<Row[]>([{ key: '', value: '' }]);
  const [env, setEnv] = useState<Row[]>([{ key: '', value: '' }]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [placement, setPlacement] = useState('auto');
  const [cpu, setCpu] = useState(50);
  const [ram, setRam] = useState(50);
  const [disk, setDisk] = useState(50);
  const [swap, setSwap] = useState(0);
  const [io, setIo] = useState('normal');
  const [restart, setRestart] = useState('on-failure');
  const [oom, setOom] = useState(false);
  const [startup, setStartup] = useState('');
  const [dbs, setDbs] = useState(1);
  const [backups, setBackups] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    listNodes()
      .then(setNodes)
      .catch(() => {});
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const image = kind === 'game' ? `nexusinfra/${game}` : dockerImage;
      await createDeployment({ name, dockerImage: image, ports: rowsToRecord(ports), env: rowsToRecord(env) });
      toast(`Deploying ${name}`, 'success');
      navigate('/servers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deployment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 24px', animation: 'rise 320ms var(--ease-out) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.4rem' }}>New Deployment</h1>
      </div>

      <div className="card spotlight" data-spotlight>
        <form onSubmit={onSubmit} style={{ padding: 24 }}>
          {/* Type */}
          <div style={{ marginBottom: 20 }}>
            <span className="field__label">Type</span>
            <div style={{ display: 'flex', gap: 10 }}>
              {[
                { v: 'app', label: 'Application', sub: 'Any Docker image' },
                { v: 'game', label: 'Game server', sub: 'Minecraft, Valheim, …' },
              ].map((o) => {
                const active = kind === o.v;
                return (
                  <button
                    key={o.v}
                    type="button"
                    data-ripple
                    onClick={() => setKind(o.v as 'app' | 'game')}
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      padding: '13px 15px',
                      borderRadius: 'var(--radius)',
                      border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
                      background: active ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                      color: active ? 'var(--color-primary)' : 'var(--color-text)',
                      cursor: 'pointer',
                      transition: 'all 160ms',
                    }}
                  >
                    <span style={{ display: 'block', fontWeight: 650, fontSize: '.92rem' }}>{o.label}</span>
                    <span style={{ display: 'block', fontSize: '.76rem', opacity: 0.82 }}>{o.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name */}
          <label className="field">
            <span className="field__label">Name <span className="field__req">*</span></span>
            <input className="input" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" required />
          </label>

          {/* App image or game picker */}
          {kind === 'app' ? (
            <label className="field">
              <span className="field__label">Docker image <span className="field__req">*</span></span>
              <input className="input" aria-label="Docker image" value={dockerImage} onChange={(e) => setDockerImage(e.target.value)} placeholder="nginx" required />
              <span className="field__hint">Any image your nodes can pull, e.g. nginx, redis, ghcr.io/org/app.</span>
            </label>
          ) : (
            <div style={{ marginBottom: 16, padding: 16, border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface-2)' }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Game</span>
              <Seg options={['minecraft', 'valheim', 'rust', 'factorio'].map((g) => ({ value: g, label: g }))} value={game} onChange={setGame} />
            </div>
          )}

          {/* Ports & env */}
          <RowEditor legend="Ports" hint="host : container" keyPlaceholder="8080" valuePlaceholder="80" rows={ports} onChange={setPorts} />
          <RowEditor legend="Environment" hint="KEY : value" keyPlaceholder="KEY" valuePlaceholder="value" rows={env} onChange={setEnv} />

          <div style={{ height: 1, background: 'var(--color-border)', margin: '6px 0 20px' }} />

          {/* Placement */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '.95rem' }}>Placement</span>
            <span style={{ display: 'block', marginBottom: 12, fontSize: '.82rem', color: 'var(--color-text-subtle)' }}>
              Choose a host node, or let the scheduler pick the emptiest one.
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[{ id: 'auto', name: 'Auto', sub: 'emptiest node' }, ...nodes.map((n) => ({ id: n.id, name: n.name, sub: n.health }))].map((o) => {
                const active = placement === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setPlacement(o.id)}
                    style={{
                      flex: 1,
                      minWidth: 112,
                      textAlign: 'left',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius)',
                      border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
                      background: active ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                      color: active ? 'var(--color-primary)' : 'var(--color-text)',
                      cursor: 'pointer',
                      transition: 'all 150ms',
                    }}
                  >
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '.86rem' }}>{o.name}</span>
                    <span className="mono" style={{ display: 'block', fontSize: '.72rem', opacity: 0.85 }}>{o.sub}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Resource limits */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '.95rem' }}>Resource limits</span>
            <span style={{ display: 'block', marginBottom: 16, fontSize: '.82rem', color: 'var(--color-text-subtle)' }}>
              Hard caps on this server's share of the host node.
            </span>
            <Slider label="CPU limit" value={cpu} onChange={setCpu} suffix="%" min={5} max={100} step={5} />
            <Slider label="RAM limit" value={ram} onChange={setRam} suffix="%" min={5} max={100} step={5} />
            <Slider label="Disk limit" value={disk} onChange={setDisk} suffix="%" min={5} max={100} step={5} />
            <Slider label="Swap (of RAM limit)" value={swap} onChange={setSwap} suffix="%" min={0} max={100} step={25} neutral />
          </div>

          {/* Runtime behavior */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 14, fontWeight: 600, fontSize: '.95rem' }}>Runtime behavior</span>
            <div style={{ marginBottom: 16 }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Block I/O priority</span>
              <Seg options={['low', 'normal', 'high'].map((v) => ({ value: v, label: v }))} value={io} onChange={setIo} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Restart policy</span>
              <Seg options={[{ value: 'no', label: 'Never' }, { value: 'on-failure', label: 'On failure' }, { value: 'always', label: 'Always' }]} value={restart} onChange={setRestart} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', cursor: 'pointer' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '.86rem', fontWeight: 550 }}>OOM killer</span>
                <span style={{ display: 'block', fontSize: '.78rem', color: 'var(--color-text-subtle)' }}>Kill the container if it exceeds its RAM limit</span>
              </span>
              <Toggle on={oom} onToggle={() => setOom((v) => !v)} />
            </label>
            <div style={{ marginTop: 16 }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Startup command <span className="subtle" style={{ fontWeight: 400 }}>(optional)</span></span>
              <input className="input mono" value={startup} onChange={(e) => setStartup(e.target.value)} placeholder="./server --port 8080" style={{ fontSize: '.86rem' }} />
            </div>
          </div>

          {/* Feature limits */}
          <div style={{ marginBottom: 22 }}>
            <span style={{ display: 'block', marginBottom: 14, fontWeight: 600, fontSize: '.95rem' }}>Feature limits</span>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Counter label="Databases" value={dbs} onChange={setDbs} />
              <Counter label="Backups" value={backups} onChange={setBackups} />
            </div>
          </div>

          {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{error}</p>}

          <button type="submit" className="btn btn--primary" data-magnetic data-ripple data-burst="success" disabled={busy} style={{ minHeight: 44, padding: '0 22px' }}>
            {busy && <span className="spinner" />}
            {busy ? 'Deploying…' : 'Deploy'}
          </button>
        </form>
      </div>
    </div>
  );
}

function Seg({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              minWidth: 70,
              minHeight: 34,
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
              background: active ? 'var(--color-primary-soft)' : 'var(--color-surface)',
              color: active ? 'var(--color-primary)' : 'var(--color-text)',
              fontWeight: 600,
              fontSize: '.8rem',
              textTransform: 'capitalize',
              cursor: 'pointer',
              transition: 'all 150ms',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Slider({ label, value, onChange, suffix, min, max, step, neutral }: { label: string; value: number; onChange: (v: number) => void; suffix: string; min: number; max: number; step: number; neutral?: boolean }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 }}>
        <span style={{ fontSize: '.86rem', fontWeight: 550 }}>{label}</span>
        <span className="mono" style={{ fontSize: '.92rem', fontWeight: 600, color: neutral ? 'var(--color-text-muted)' : limitColor(value) }}>
          {value}
          {suffix}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${label} percent`} />
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      style={{ flex: 'none', width: 44, height: 26, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer', padding: 3, transition: 'background 200ms', background: on ? 'var(--color-primary)' : 'var(--color-border-strong)' }}
    >
      <span style={{ display: 'block', width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'transform 200ms var(--ease-out)', transform: on ? 'translateX(18px)' : 'translateX(0)' }} />
    </button>
  );
}

function Counter({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ flex: 1, minWidth: 150, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)' }}>
      <span style={{ fontSize: '.86rem', fontWeight: 550 }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <button type="button" className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => onChange(Math.max(0, value - 1))} aria-label={`Fewer ${label.toLowerCase()}`}>−</button>
        <span className="mono" style={{ minWidth: 16, textAlign: 'center', fontWeight: 600 }}>{value}</span>
        <button type="button" className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => onChange(value + 1)} aria-label={`More ${label.toLowerCase()}`}>+</button>
      </span>
    </div>
  );
}

function RowEditor({ legend, hint, keyPlaceholder, valuePlaceholder, rows, onChange }: { legend: string; hint: string; keyPlaceholder: string; valuePlaceholder: string; rows: Row[]; onChange: (rows: Row[]) => void }) {
  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [{ key: '', value: '' }]);
  return (
    <div className="field">
      <span className="field__label">
        {legend} <span className="subtle" style={{ fontWeight: 400 }}>({hint})</span>
      </span>
      <div className="stack">
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ flexWrap: 'nowrap' } as CSSProperties}>
            <input className="input" aria-label={`${legend} key ${i + 1}`} placeholder={keyPlaceholder} value={r.key} onChange={(e) => update(i, { key: e.target.value })} />
            <input className="input" aria-label={`${legend} value ${i + 1}`} placeholder={valuePlaceholder} value={r.value} onChange={(e) => update(i, { value: e.target.value })} />
            <button type="button" className="icon-btn" data-ripple onClick={() => remove(i)} aria-label={`Remove ${legend.toLowerCase()} row ${i + 1}`}>−</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn--secondary btn--sm" data-ripple style={{ marginTop: 10 }} onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <IconPlus size={15} />
        Add {legend.toLowerCase()}
      </button>
    </div>
  );
}
