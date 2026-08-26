import { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDeployment, listNodes, listEggs, type NodeView, type Egg, type EggVariable } from '../api';
import { IconPlus } from '../components/Icons';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';
import { getDeploymentDefaults } from '../prefs';
import { parseMemoryMb, jvmOverheadMb } from '../memory';

// New Deployment — ported from the redesign. The deploy sends name, image, ports,
// env, the resource limits + restart policy, the kind and the chosen placement,
// all persisted with the server config (#106); the limits are enforced at
// container start (#107) and a pinned node is honoured or refused, never silently
// overruled (#254).
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
  const [eggs, setEggs] = useState<Egg[]>([]);
  const [eggId, setEggId] = useState('');
  // Answers keyed by variable; a key absent here means "use the egg's default",
  // which is also how the API reads it.
  const [eggValues, setEggValues] = useState<Record<string, string>>({});
  // Importing an existing directory (#268) — platform admins only; the node checks
  // the path and refuses anything outside its import root.
  const [dataPath, setDataPath] = useState('');
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    listNodes()
      .then(setNodes)
      .catch(() => {});
    listEggs()
      .then((list) => {
        setEggs(list);
        setEggId((current) => current || list[0]?.id || '');
      })
      .catch(() => {});
  }, []);

  const egg = eggs.find((e) => e.id === eggId) ?? null;
  const setEggValue = (key: string, value: string) => setEggValues((prev) => ({ ...prev, [key]: value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // An egg decides its own image and environment server-side (#231); a plain
      // application deployment carries the image and rows the form collected.
      const fromEgg = kind === 'game' && egg;
      await createDeployment({
        name,
        ...(fromEgg
          ? { eggId: egg.id, eggValues, ports: rowsToRecord(ports), ...(dataPath.trim() ? { dataPath: dataPath.trim() } : {}) }
          : { dockerImage, ports: rowsToRecord(ports), env: rowsToRecord(env), type: 'app' }),
        // 'auto' means "you pick"; anything else is a deliberate pin the API honours (#254).
        nodeId: placement === 'auto' ? undefined : placement,
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

  // The container's memory cap in MB on the node this will land on (#271).
  // `ramPercent` is a share of that node, so the same 50% is 2 GB on a small box
  // and 32 GB on a large one — showing the percentage alone tells nobody anything.
  const capMb = target?.ramTotalMb ? Math.round((ram / 100) * target.ramTotalMb) : null;

  // Mirrors the orchestrator's rule so the clash is visible while you are setting
  // it, not after the container is killed. The API is still the one that refuses.
  const heapMb = egg?.memoryVariable ? parseMemoryMb(eggValues[egg.memoryVariable] ?? egg.variables.find((v) => v.key === egg.memoryVariable)?.default ?? '') : null;
  const heapWarning =
    kind === 'game' && heapMb != null && capMb != null && heapMb + jvmOverheadMb(heapMb) > capMb
      ? `A ${heapMb} MB heap will not fit a ${capMb} MB limit — Java claims the whole heap up front and needs roughly ${jvmOverheadMb(heapMb)} MB more for itself. Raise the RAM limit or lower the heap.`
      : null;

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
                <span className="field__label" style={{ fontSize: '.86rem' }}>
                  Egg
                  <InfoHint text="A ready-made recipe: which image to run, which port to publish and which settings the server understands. The orchestrator applies and validates it, so the options below are the ones this server actually has." label="Egg help" />
                </span>
                {eggs.length === 0 ? (
                  <span className="subtle" style={{ fontSize: '.84rem' }}>Loading the catalogue…</span>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {eggs.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        data-ripple
                        onClick={() => {
                          setEggId(e.id);
                          setEggValues({});
                        }}
                        className={`opt opt--card${eggId === e.id ? ' is-active' : ''}`}
                        style={{ minWidth: 150, textAlign: 'left' }}
                      >
                        <span style={{ display: 'block', fontWeight: 650, fontSize: '.88rem' }}>{e.name}</span>
                        <span className="mono" style={{ display: 'block', fontSize: '.72rem', opacity: 0.8 }}>{e.dockerImage}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {egg && (
                <>
                  <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>{egg.description}</p>
                  {/* Rendered from the egg, so a new egg needs no dashboard change. */}
                  {egg.variables.map((v) => (
                    <EggField key={v.key} variable={v} value={eggValues[v.key] ?? v.default} onChange={(val) => setEggValue(v.key, val)} />
                  ))}
                  <span className="subtle" style={{ display: 'block', fontSize: '.8rem', marginBottom: 14 }}>
                    Publishes port {Object.keys(egg.ports)[0]} by default — override it under Ports below.
                  </span>
                  <div className="field">
                    <label className="field__label" htmlFor="egg-datapath">
                      Import an existing directory <span className="subtle" style={{ fontWeight: 400 }}>(optional)</span>
                      <InfoHint text={`A folder already on the node — an existing world and config — mounted at ${egg.dataPath} so this server runs against the files that are already there. Administrators only, and the node refuses anything outside its configured import root.`} label="Import help" />
                    </label>
                    <input
                      id="egg-datapath"
                      className="input mono"
                      value={dataPath}
                      onChange={(e) => setDataPath(e.target.value)}
                      placeholder="/srv/import/my-minecraft-server"
                    />
                    <span className="field__hint">
                      Leave empty to start from an empty {egg.dataPath}. Requires IMPORT_ROOT on the node and a platform administrator.
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Ports & env */}
          <RowEditor legend="Ports" hint="host : container" keyPlaceholder="8080" valuePlaceholder="80" rows={ports} onChange={setPorts} />
          {/* An egg owns its environment: the fields above are that environment,
              validated server-side. Free-form rows here would let a caller set
              anything at all, which is what moving the recipe off the client fixed. */}
          {kind === 'app' && (
            <RowEditor legend="Environment" hint="KEY : value" keyPlaceholder="KEY" valuePlaceholder="value" rows={env} onChange={setEnv} />
          )}

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
            <Slider
              label="RAM limit"
              value={ram}
              onChange={setRam}
              suffix="%"
              min={5}
              max={100}
              step={5}
              hint="The most host RAM this server may use, as a share of the node's memory. Exceeding it triggers the OOM policy below."
              note={capMb != null ? `${capMb} MB on ${target?.name ?? 'the chosen node'}` : undefined}
            />
            {heapWarning && (
              <p role="alert" className="alert alert--error" style={{ margin: '4px 0 14px', fontSize: '.82rem' }}>
                {heapWarning}
              </p>
            )}
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
            {/*
              A "Startup command" input sat here. Its value was written to state
              and read by nothing: no request field, no event, and the node agent
              has no way to override a container's command (#255). It returns when
              the override exists end to end.
            */}
          </div>

          {/*
            A "Feature limits" section capped how many databases and backups this
            server could create. Neither value was submitted and nothing enforced
            them (#256). The quota that does exist is per-plan in the hosted
            edition (#148), not per-server.
          */}

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

/** One egg variable, rendered according to its kind. */
function EggField({ variable, value, onChange }: { variable: EggVariable; value: string; onChange: (v: string) => void }) {
  const id = `egg-${variable.key}`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {variable.label}
        <InfoHint text={variable.description} label={`${variable.label} help`} />
      </label>
      {variable.kind === 'choice' ? (
        <Seg options={(variable.options ?? []).map((o) => ({ value: o, label: o }))} value={value} onChange={onChange} />
      ) : variable.kind === 'boolean' ? (
        <Toggle on={value === 'true'} onToggle={() => onChange(value === 'true' ? 'false' : 'true')} />
      ) : (
        <input
          id={id}
          className={variable.kind === 'integer' ? 'input mono' : 'input'}
          type={variable.kind === 'integer' ? 'number' : 'text'}
          min={variable.min}
          max={variable.max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <span className="field__hint">{variable.description}</span>
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

function Slider({ label, value, onChange, suffix, min, max, step, neutral, hint, note }: { label: string; value: number; onChange: (v: number) => void; suffix: string; min: number; max: number; step: number; neutral?: boolean; hint?: string; note?: string }) {
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
      {/* Shown rather than tucked into the tooltip: a percentage of a node you
          have not measured is not a number anyone can act on (#271). */}
      {note && <span className="subtle" style={{ display: 'block', marginTop: 6, fontSize: '.78rem' }}>{note}</span>}
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
