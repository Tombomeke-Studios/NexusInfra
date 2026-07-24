import { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDeployment, listNodes, type NodeView } from '../api';
import { IconPlus } from '../components/Icons';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';
import { getDeploymentDefaults } from '../prefs';

// New Deployment — ported from the redesign. The deploy sends name, image, ports,
// env, the resource limits + restart policy and the kind, all persisted with the
// server config (#106); enforcing the limits at container start is #107. The game
// picker, placement and feature limits remain UI for now.
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
  // Seed the form from the user's saved defaults (#124); each field stays editable.
  const defaults = getDeploymentDefaults();
  const [kind, setKind] = useState<'app' | 'game'>(defaults.type);
  const [name, setName] = useState('');
  const [dockerImage, setDockerImage] = useState('');
  const [game, setGame] = useState('minecraft');
  const [software, setSoftware] = useState('paper');
  const [version, setVersion] = useState('1.21.4');
  const [slots, setSlots] = useState(20);
  const [motd, setMotd] = useState('');
  const [ports, setPorts] = useState<Row[]>([{ key: '', value: '' }]);
  const [env, setEnv] = useState<Row[]>([{ key: '', value: '' }]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [placement, setPlacement] = useState('auto');
  const [cpu, setCpu] = useState(defaults.cpu);
  const [ram, setRam] = useState(defaults.ram);
  const [disk, setDisk] = useState(defaults.disk);
  const [swap, setSwap] = useState(defaults.swap);
  const [io, setIo] = useState<string>(defaults.io);
  const [restart, setRestart] = useState<string>(defaults.restart);
  const [oom, setOom] = useState(defaults.oom);
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
      await createDeployment({
        name,
        dockerImage: image,
        ports: rowsToRecord(ports),
        env: rowsToRecord(env),
        type: kind,
        autoRestart: restart !== 'no',
        resourceLimits: {
          cpuPercent: cpu,
          ramPercent: ram,
          diskPercent: disk,
          swapPercent: swap,
          ioPriority: io as 'low' | 'normal' | 'high',
          restartPolicy: restart as 'no' | 'on-failure' | 'always',
          oomKill: oom,
        },
      });
      toast(`Deploying ${name}`, 'success');
      navigate('/servers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deployment');
    } finally {
      setBusy(false);
    }
  };

  // Placement headroom (from the selected/emptiest node's live usage).
  const usedCpu = (n: NodeView) => Math.round(n.cpuPercent ?? 0);
  const usedRam = (n: NodeView) => (n.ramUsedMb != null && n.ramTotalMb ? Math.round((n.ramUsedMb / n.ramTotalMb) * 100) : 0);
  const target = placement === 'auto' ? [...nodes].sort((a, b) => usedCpu(a) + usedRam(a) - (usedCpu(b) + usedRam(b)))[0] : nodes.find((n) => n.id === placement);
  const cpuFree = target ? Math.max(0, 100 - usedCpu(target)) : 100;
  const ramFree = target ? Math.max(0, 100 - usedRam(target)) : 100;
  const overCapacity = cpu > cpuFree || ram > ramFree;

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 24px', animation: 'rise 320ms var(--ease-out) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: '1.4rem' }}>New Deployment</h1>
      </div>

      <div className="card spotlight" data-spotlight>
        <form onSubmit={onSubmit} style={{ padding: 24 }}>
          {/* Type */}
          <div style={{ marginBottom: 20 }}>
            <span className="field__label">Type<InfoHint text="Application runs any Docker image you provide. Game server uses a curated image and startup for popular games (Minecraft, Valheim…)." label="Type help" /></span>
            <div style={{ display: 'flex', gap: 10 }}>
              {[
                { v: 'app', label: 'Application', sub: 'Any Docker image' },
                { v: 'game', label: 'Game server', sub: 'Minecraft, Valheim, …' },
              ].map((o) => {
                return (
                  <button
                    key={o.v}
                    type="button"
                    data-ripple
                    onClick={() => setKind(o.v as 'app' | 'game')}
                    className={`opt opt--card opt--lg${kind === o.v ? ' is-active' : ''}`}
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
              <div style={{ marginBottom: 14 }}>
                <span className="field__label" style={{ fontSize: '.86rem' }}>Game</span>
                <Seg options={['minecraft', 'valheim', 'rust', 'cs2'].map((g) => ({ value: g, label: g }))} value={game} onChange={setGame} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <span className="field__label" style={{ fontSize: '.86rem' }}>Software</span>
                <Seg options={['paper', 'fabric', 'forge', 'vanilla', 'purpur'].map((s) => ({ value: s, label: s }))} value={software} onChange={setSoftware} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <span className="field__label" style={{ fontSize: '.86rem' }}>Version</span>
                <Seg options={['1.21.4', '1.21.1', '1.20.6', '1.20.1', '1.19.4'].map((v) => ({ value: v, label: v }))} value={version} onChange={setVersion} />
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 'none', width: 120 }}>
                  <span className="field__label" style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>Max players</span>
                  <input className="input mono" type="number" min={1} max={500} value={slots} onChange={(e) => setSlots(Number(e.target.value))} />
                </label>
                <label style={{ flex: 1, minWidth: 0 }}>
                  <span className="field__label" style={{ fontSize: '.8rem', color: 'var(--color-text-muted)' }}>MOTD</span>
                  <input className="input" value={motd} onChange={(e) => setMotd(e.target.value)} placeholder="A NexusInfra server" />
                </label>
              </div>
            </div>
          )}

          {/* Ports & env */}
          <RowEditor legend="Ports" hint="host : container" keyPlaceholder="8080" valuePlaceholder="80" rows={ports} onChange={setPorts} />
          <RowEditor legend="Environment" hint="KEY : value" keyPlaceholder="KEY" valuePlaceholder="value" rows={env} onChange={setEnv} />

          <div style={{ height: 1, background: 'var(--color-border)', margin: '6px 0 20px' }} />

          {/* Placement */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '.95rem' }}>Placement<InfoHint text="Which node hosts this server. Auto picks the emptiest healthy node by live CPU + RAM; or pin it to a specific node." label="Placement help" /></span>
            <span style={{ display: 'block', marginBottom: 12, fontSize: '.82rem', color: 'var(--color-text-subtle)' }}>
              Choose a host node, or let the scheduler pick the emptiest one.
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[{ id: 'auto', name: 'Auto', sub: 'emptiest node' }, ...nodes.map((n) => ({ id: n.id, name: n.name, sub: n.health }))].map((o) => {
                return (
                  <button
                    key={o.id}
                    type="button"
                    data-ripple
                    onClick={() => setPlacement(o.id)}
                    className={`opt opt--card${placement === o.id ? ' is-active' : ''}`}
                    style={{ minWidth: 112 }}
                  >
                    <span style={{ display: 'block', fontWeight: 600, fontSize: '.86rem' }}>{o.name}</span>
                    <span className="mono" style={{ display: 'block', fontSize: '.72rem', opacity: 0.85 }}>{o.sub}</span>
                  </button>
                );
              })}
            </div>

            {/* Headroom on the chosen node */}
            <div style={{ marginTop: 14, padding: '14px 16px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <span style={{ fontSize: '.82rem', fontWeight: 600 }}>Available on {target ? target.name : 'the chosen node'}</span>
                <span style={{ fontSize: '.74rem', color: 'var(--color-text-subtle)' }}>after currently committed limits</span>
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                {[{ label: 'CPU free', free: cpuFree, req: cpu }, { label: 'RAM free', free: ramFree, req: ram }].map((m) => (
                  <div key={m.label} style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ fontSize: '.78rem', color: 'var(--color-text-muted)' }}>{m.label}</span>
                      <span className="tnum" style={{ fontSize: '.78rem', fontWeight: 600, color: m.req > m.free ? 'var(--color-danger)' : 'var(--color-success)' }}>{m.free}%</span>
                    </div>
                    <div className="meter" style={{ height: 7, background: 'var(--color-surface)' }}>
                      <div className="meter__fill" style={{ width: `${m.free}%`, background: m.req > m.free ? 'var(--color-danger)' : 'var(--color-success)', transition: 'width 500ms var(--ease-out)' }} />
                    </div>
                  </div>
                ))}
              </div>
              {overCapacity && (
                <div style={{ marginTop: 12, fontSize: '.8rem', fontWeight: 550, color: 'var(--color-danger)' }}>⚠ Requested limits exceed free capacity on this node.</div>
              )}
            </div>
          </div>

          {/* Resource limits */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '.95rem' }}>Resource limits<InfoHint text="Hard caps on this server's share of the host node. They're enforced on the container at start, so a busy server can't starve its neighbours." label="Resource limits help" /></span>
            <span style={{ display: 'block', marginBottom: 16, fontSize: '.82rem', color: 'var(--color-text-subtle)' }}>
              Hard caps on this server's share of the host node.
            </span>
            <Slider label="CPU limit" value={cpu} onChange={setCpu} suffix="%" min={5} max={100} step={5} hint="The most host CPU this server may use, as a share of the node's cores. 100% ≈ all cores; the container is throttled above this." />
            <Slider label="RAM limit" value={ram} onChange={setRam} suffix="%" min={5} max={100} step={5} hint="The most host RAM this server may use, as a share of the node's memory. Exceeding it triggers the OOM policy below." />
            <Slider label="Disk limit" value={disk} onChange={setDisk} suffix="%" min={5} max={100} step={5} hint="The share of the node's disk this server's files may occupy." />
            <Slider label="Swap (of RAM limit)" value={swap} onChange={setSwap} suffix="%" min={0} max={100} step={25} neutral hint="Extra swap space as a percentage of the RAM limit. 0% disables swap for this server; swap is slower disk-backed memory used when RAM is full." />
          </div>

          {/* Runtime behavior */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 14, fontWeight: 600, fontSize: '.95rem' }}>Runtime behavior</span>
            <div style={{ marginBottom: 16 }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Block I/O priority<InfoHint text="How much disk read/write bandwidth this server gets when nodes are busy. Higher wins contention; most apps are fine on normal." label="Block I/O help" /></span>
              <Seg options={['low', 'normal', 'high'].map((v) => ({ value: v, label: v }))} value={io} onChange={setIo} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Restart policy<InfoHint text="What Docker does when the container exits. Never = leave stopped; On failure = restart only on a non-zero exit (bounded retries); Always = keep it running." label="Restart policy help" /></span>
              <Seg options={[{ value: 'no', label: 'Never' }, { value: 'on-failure', label: 'On failure' }, { value: 'always', label: 'Always' }]} value={restart} onChange={setRestart} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', cursor: 'pointer' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '.86rem', fontWeight: 550 }}>OOM killer<InfoHint text="When on, the container is killed if it exceeds its RAM limit (protects the node). When off, it may be throttled instead — only valid with a RAM limit set." label="OOM killer help" /></span>
                <span style={{ display: 'block', fontSize: '.78rem', color: 'var(--color-text-subtle)' }}>Kill the container if it exceeds its RAM limit</span>
              </span>
              <Toggle on={oom} onToggle={() => setOom((v) => !v)} />
            </label>
            <div style={{ marginTop: 16 }}>
              <span className="field__label" style={{ fontSize: '.86rem' }}>Startup command <span className="subtle" style={{ fontWeight: 400 }}>(optional)</span><InfoHint text="Override the command run inside the container. Leave blank to use the image's default entrypoint." label="Startup command help" /></span>
              <input className="input mono" value={startup} onChange={(e) => setStartup(e.target.value)} placeholder="./server --port 8080" style={{ fontSize: '.86rem' }} />
            </div>
          </div>

          {/* Feature limits */}
          <div style={{ marginBottom: 22 }}>
            <span style={{ display: 'block', marginBottom: 14, fontWeight: 600, fontSize: '.95rem' }}>Feature limits<InfoHint text="Caps on the extras this server may create: how many managed databases and stored backups it's allowed." label="Feature limits help" /></span>
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
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-ripple
          onClick={() => onChange(o.value)}
          className={`opt${o.value === value ? ' is-active' : ''}`}
          style={{ textTransform: 'capitalize' }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, onChange, suffix, min, max, step, neutral, hint }: { label: string; value: number; onChange: (v: number) => void; suffix: string; min: number; max: number; step: number; neutral?: boolean; hint?: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 }}>
        <span style={{ fontSize: '.86rem', fontWeight: 550 }}>{label}{hint && <InfoHint text={hint} label={`${label} help`} />}</span>
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
