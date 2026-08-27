import { useEffect, useState, type FormEvent, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDeployment, listNodes, listEggs, getPlacement, type NodeView, type Egg, type EggVariable } from '../api';
import { IconPlus } from '../components/Icons';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';
import { getDeploymentDefaults } from '../prefs';
import { parseMemoryMb, jvmOverheadMb, derivedHeapMb, formatHeapMb } from '../memory';

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

/**
 * A copy without one key — used to *omit* the heap, which is what asks the API to
 * derive it from the memory limit (#308).
 *
 * Omitted, not blanked: the egg reads an empty value as "use my default", which
 * is the fixed `2G` this replaced.
 */
function withoutKey(values: Record<string, string>, key: string): Record<string, string> {
  const copy = { ...values };
  delete copy[key];
  return copy;
}

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
  // The heap is a consequence of the memory limit, not a second setting for the
  // same RAM (#308). Ticking this takes it back, and only then is a value sent —
  // an absent one is what tells the API to derive.
  const [ownHeap, setOwnHeap] = useState(false);
  // Which node automatic placement would land on, as the orchestrator sees it.
  const [autoNodeId, setAutoNodeId] = useState<string | null>(null);
  // Importing an existing directory (#268) — platform admins only; the node checks
  // the path and refuses anything outside its import root.
  const [dataPath, setDataPath] = useState('');
  const [ports, setPorts] = useState<Row[]>([{ key: '', value: '' }]);
  const [env, setEnv] = useState<Row[]>([{ key: '', value: '' }]);
  const [nodes, setNodes] = useState<NodeView[]>([]);
  const [placement, setPlacement] = useState('auto');
  const [cpu, setCpu] = useState(defaults.cpu);
  const [ram, setRam] = useState(defaults.ram);
  // Set the limits in whichever unit you are actually thinking in (#275). Nobody
  // decides "37% of the box"; they decide "6 GB" or "2 cores".
  const [ramUnit, setRamUnit] = useState<'percent' | 'mb'>('percent');
  const [cpuUnit, setCpuUnit] = useState<'percent' | 'cores'>('percent');
  const [ramMb, setRamMb] = useState(2048);
  const [cpuCores, setCpuCores] = useState(2);
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
    // Which node automatic placement would choose, from the orchestrator (#309).
    getPlacement()
      .then((p) => setAutoNodeId(p.nodeId))
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
  /** Which egg variable is the JVM heap, when this egg has one (#308). */
  const heapVariable = egg?.memoryVariable;

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
          ? {
              eggId: egg.id,
              // Sending no heap is what asks the API to derive one from the limit
              // (#308); sending one is how an override survives.
              eggValues: heapVariable && !ownHeap ? withoutKey(eggValues, heapVariable) : eggValues,
              ports: rowsToRecord(ports),
              ...(dataPath.trim() ? { dataPath: dataPath.trim() } : {}),
            }
          : { dockerImage, ports: rowsToRecord(ports), env: rowsToRecord(env), type: 'app' }),
        // 'auto' means "you pick"; anything else is a deliberate pin the API honours (#254).
        nodeId: placement === 'auto' ? undefined : placement,
        autoRestart: restart !== 'no',
        resourceLimits: {
          // Send whichever unit was chosen; the absolute one wins server-side, so
          // sending both would only be ambiguous.
          ...(cpuUnit === 'cores' ? { cpuCores } : { cpuPercent: cpu }),
          ...(ramUnit === 'mb' ? { ramMb } : { ramPercent: ram }),
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

  // Which node this will land on. Asked of the orchestrator rather than worked
  // out here (#309): the form's own rule filtered neither unhealthy nor draining
  // nodes and scored unknown metrics differently, so with two or more nodes every
  // figure below — the cap in MB, the headroom, the heap — could be about a
  // machine the server was never going to land on.
  const target = placement === 'auto' ? nodes.find((n) => n.id === autoNodeId) : nodes.find((n) => n.id === placement);

  // The container's memory cap in MB on the node this will land on (#271).
  // `ramPercent` is a share of that node, so the same 50% is 2 GB on a small box
  // and 32 GB on a large one — showing the percentage alone tells nobody anything.
  const capMb = ramUnit === 'mb' ? ramMb : target?.ramTotalMb ? Math.round((ram / 100) * target.ramTotalMb) : null;

  // What the API will derive, mirrored so the number is visible while the slider
  // moves rather than only after the server exists (#308). The API still decides.
  const derivedHeap = heapVariable ? derivedHeapMb(capMb) : null;

  // The heap actually in play: theirs when they took it over, otherwise ours.
  const heapMb = egg?.memoryVariable
    ? ownHeap
      ? parseMemoryMb(eggValues[egg.memoryVariable] ?? egg.variables.find((v) => v.key === egg.memoryVariable)?.default ?? '')
      : derivedHeap
    : null;

  // Only reachable with a heap somebody chose: a derived one fits by construction.
  const heapWarning =
    kind === 'game' && ownHeap && heapMb != null && capMb != null && heapMb + jvmOverheadMb(heapMb) > capMb
      ? `A ${heapMb} MB heap will not fit a ${capMb} MB limit — Java claims the whole heap up front and needs roughly ${jvmOverheadMb(heapMb)} MB more for itself. Raise the RAM limit or lower the heap.`
      : null;

  // A limit no JVM can run in at all — say that, rather than showing no heap and
  // letting the create fail with an error about a heap nobody set.
  const heapTooSmall = kind === 'game' && Boolean(egg?.memoryVariable) && !ownHeap && capMb != null && derivedHeap == null;

  // What is genuinely left to hand out, from the orchestrator (#275): total minus
  // what is already *committed* to other servers. The old figure here was live
  // usage, which is wrong twice — four idle servers still leave nothing to give,
  // and a node running nothing reports most of its RAM used as page cache.
  const capacity = target?.capacity;
  const ramAvailableMb = capacity?.ramAvailableMb ?? null;
  const coresAvailable = capacity?.cpuCoresAvailable ?? null;

  // The request in absolute terms, whichever unit it was entered in.
  const requestedRamMb =
    ramUnit === 'mb' ? ramMb : capacity?.ramTotalMb != null ? Math.round((ram / 100) * capacity.ramTotalMb) : null;
  const requestedCores =
    cpuUnit === 'cores' ? cpuCores : capacity?.cpuCoresTotal != null ? (cpu / 100) * capacity.cpuCoresTotal : null;

  // Switching unit converts what is already set rather than snapping to a
  // constant: you are changing how the number is expressed, not what you asked
  // for. Falls back to the current value when the node has not reported totals.
  const switchRamUnit = (next: 'percent' | 'mb') => {
    if (next === ramUnit) return;
    if (next === 'mb' && capacity?.ramTotalMb != null) setRamMb(Math.round((ram / 100) * capacity.ramTotalMb));
    if (next === 'percent' && capacity?.ramTotalMb) setRam(Math.max(1, Math.round((ramMb / capacity.ramTotalMb) * 100)));
    setRamUnit(next);
  };
  const switchCpuUnit = (next: 'percent' | 'cores') => {
    if (next === cpuUnit) return;
    if (next === 'cores' && capacity?.cpuCoresTotal != null) setCpuCores(Math.round((cpu / 100) * capacity.cpuCoresTotal * 10) / 10);
    if (next === 'percent' && capacity?.cpuCoresTotal) setCpu(Math.max(1, Math.round((cpuCores / capacity.cpuCoresTotal) * 100)));
    setCpuUnit(next);
  };

  const overRam = ramAvailableMb != null && requestedRamMb != null && requestedRamMb > ramAvailableMb;
  const overCpu = coresAvailable != null && requestedCores != null && requestedCores > coresAvailable;
  const overCapacity = overRam || overCpu;

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
                  {/* Every variable except the heap, which follows the memory
                      limit further down rather than being asked for twice (#308). */}
                  {egg.variables
                    .filter((v) => v.key !== egg.memoryVariable)
                    .map((v) => (
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
                <CapacityBar
                  label="Memory"
                  total={capacity?.ramTotalMb ?? null}
                  committed={capacity?.ramCommittedMb ?? 0}
                  requested={requestedRamMb}
                  format={(v) => `${v} MB`}
                />
                <CapacityBar
                  label="CPU"
                  total={capacity?.cpuCoresTotal ?? null}
                  committed={capacity?.cpuCoresCommitted ?? 0}
                  requested={requestedCores}
                  format={(v) => `${Math.round(v * 100) / 100} ${v === 1 ? 'core' : 'cores'}`}
                />
              </div>
              {overCapacity && (
                <div role="alert" style={{ marginTop: 12, fontSize: '.8rem', fontWeight: 550, color: 'var(--color-danger)' }}>
                  ⚠ More than this node has left. It has {ramAvailableMb != null ? `${ramAvailableMb} MB` : 'an unknown amount of memory'} and{' '}
                  {coresAvailable != null ? `${coresAvailable} cores` : 'an unknown number of cores'} uncommitted.
                </div>
              )}
              {capacity?.overCommitted && (
                <div style={{ marginTop: 12, fontSize: '.8rem', color: 'var(--color-warning)' }}>
                  This node has already been promised more than it has.
                </div>
              )}
            </div>
          </div>

          {/* Resource limits */}
          <div style={{ marginBottom: 20 }}>
            <span style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '.95rem' }}>Resource limits<InfoHint text="Hard caps on this server's share of the host node. They're enforced on the container at start, so a busy server can't starve its neighbours." label="Resource limits help" /></span>
            <span style={{ display: 'block', marginBottom: 16, fontSize: '.82rem', color: 'var(--color-text-subtle)' }}>
              Hard caps on this server's share of the host node.
            </span>
            <LimitField
              label="CPU limit"
              unit={cpuUnit}
              onUnitChange={switchCpuUnit}
              units={[
                { value: 'cores', label: 'cores' },
                { value: 'percent', label: '%' },
              ]}
              hint="The most CPU this server may use. The container is throttled above it, so a busy server cannot starve its neighbours."
              absoluteValue={cpuCores}
              onAbsoluteChange={setCpuCores}
              absoluteStep={0.5}
              absoluteMax={capacity?.cpuCoresTotal ?? undefined}
              percentValue={cpu}
              onPercentChange={setCpu}
              note={coresAvailable != null ? `${coresAvailable} of ${capacity?.cpuCoresTotal} cores uncommitted on ${target?.name ?? 'this node'}` : undefined}
            />
            <LimitField
              label="RAM limit"
              unit={ramUnit}
              onUnitChange={switchRamUnit}
              units={[
                { value: 'mb', label: 'MB' },
                { value: 'percent', label: '%' },
              ]}
              hint="The most memory this server may use. Exceeding it triggers the OOM policy below."
              absoluteValue={ramMb}
              onAbsoluteChange={setRamMb}
              absoluteStep={256}
              absoluteMax={capacity?.ramTotalMb ?? undefined}
              percentValue={ram}
              onPercentChange={setRam}
              note={
                ramAvailableMb != null
                  ? `${ramAvailableMb} MB of ${capacity?.ramTotalMb} MB uncommitted on ${target?.name ?? 'this node'}`
                  : capMb != null
                    ? `${capMb} MB on ${target?.name ?? 'the chosen node'}`
                    : undefined
              }
            />
            {kind === 'game' && egg?.memoryVariable && (
              <div className="field" style={{ marginTop: 4 }}>
                <span className="field__label">
                  Java heap
                  <InfoHint
                    text="Java claims its heap up front, so it is taken whether the server needs it or not. It has to fit inside the memory limit above with room for Java itself — so it follows that limit instead of being a second number to keep in step."
                    label="Java heap help"
                  />
                </span>

                {ownHeap ? (
                  <EggField
                    variable={egg.variables.find((v) => v.key === egg.memoryVariable)!}
                    value={eggValues[egg.memoryVariable] ?? formatHeapMb(derivedHeap ?? 0)}
                    onChange={(val) => setEggValue(egg.memoryVariable!, val)}
                  />
                ) : heapTooSmall ? (
                  <p role="alert" className="alert alert--error" style={{ margin: '0 0 8px', fontSize: '.82rem' }}>
                    A {capMb} MB limit is too small to run a Java server at all — Java needs several hundred megabytes
                    beyond its heap. Raise the memory limit above.
                  </p>
                ) : derivedHeap != null ? (
                  <p className="subtle" style={{ margin: '0 0 8px', fontSize: '.84rem' }}>
                    <strong className="mono">{derivedHeap} MB</strong>, from the {capMb} MB limit above. The remaining{' '}
                    {capMb != null ? capMb - derivedHeap : 0} MB is for Java itself — metaspace, threads and buffers.
                  </p>
                ) : (
                  <p className="subtle" style={{ margin: '0 0 8px', fontSize: '.84rem' }}>
                    Set by the image, because this server has no memory limit to derive one from.
                  </p>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem' }}>
                  <input type="checkbox" checked={ownHeap} onChange={(e) => setOwnHeap(e.target.checked)} />
                  Set the heap myself
                </label>
              </div>
            )}
            {heapWarning && (
              <p role="alert" className="alert alert--error" style={{ margin: '4px 0 14px', fontSize: '.82rem' }}>
                {heapWarning}
              </p>
            )}
            {/*
              A "Disk limit" slider sat here. It was persisted and never enforced:
              resourceLimitsToHostConfig has no disk field, and a per-container
              quota needs a backing filesystem with project quotas (xfs+pquota),
              which most hosts do not have (#276). It returns when it can mean
              something on the node it is set for.
            */}
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

/**
 * A capacity bar in the node's own units (#275).
 *
 * Shows committed against total, with the pending request stacked on top, so the
 * question being asked ("does this fit") is the one the picture answers.
 */
function CapacityBar({
  label,
  total,
  committed,
  requested,
  format,
}: {
  label: string;
  total: number | null;
  committed: number;
  requested: number | null;
  format: (v: number) => string;
}) {
  if (total == null) {
    return (
      <div style={{ flex: 1, minWidth: 160 }}>
        <span style={{ fontSize: '.78rem', color: 'var(--color-text-muted)' }}>{label}</span>
        <span className="subtle" style={{ display: 'block', fontSize: '.76rem' }}>not reported by this node yet</span>
      </div>
    );
  }

  const committedPct = Math.min(100, (committed / total) * 100);
  const requestedPct = requested != null ? Math.min(100 - committedPct, (requested / total) * 100) : 0;
  const over = requested != null && committed + requested > total;

  return (
    <div style={{ flex: 1, minWidth: 180 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: '.78rem', color: 'var(--color-text-muted)' }}>{label}</span>
        <span className="tnum" style={{ fontSize: '.78rem', fontWeight: 600, color: over ? 'var(--color-danger)' : 'var(--color-success)' }}>
          {format(Math.max(0, total - committed))} free
        </span>
      </div>
      <div className="meter" style={{ height: 7, background: 'var(--color-surface)', display: 'flex', overflow: 'hidden' }}>
        <div style={{ width: `${committedPct}%`, background: 'var(--color-text-subtle)', transition: 'width 400ms var(--ease-out)' }} />
        <div style={{ width: `${requestedPct}%`, background: over ? 'var(--color-danger)' : 'var(--color-primary)', transition: 'width 400ms var(--ease-out)' }} />
      </div>
      <span className="subtle" style={{ display: 'block', marginTop: 4, fontSize: '.74rem' }}>
        {format(committed)} committed of {format(total)}
      </span>
    </div>
  );
}

/** A limit set either as an absolute amount or as a share of the node (#275). */
function LimitField<U extends string>({
  label,
  unit,
  onUnitChange,
  units,
  hint,
  absoluteValue,
  onAbsoluteChange,
  absoluteStep,
  absoluteMax,
  percentValue,
  onPercentChange,
  note,
}: {
  label: string;
  unit: U;
  onUnitChange: (u: U) => void;
  units: { value: U; label: string }[];
  hint: string;
  absoluteValue: number;
  onAbsoluteChange: (v: number) => void;
  absoluteStep: number;
  absoluteMax?: number;
  percentValue: number;
  onPercentChange: (v: number) => void;
  note?: string;
}) {
  const isPercent = unit === 'percent';
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9, gap: 10 }}>
        <span style={{ fontSize: '.86rem', fontWeight: 550 }}>
          {label}
          <InfoHint text={hint} label={`${label} help`} />
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {units.map((u) => (
            <button
              key={u.value}
              type="button"
              data-ripple
              onClick={() => onUnitChange(u.value)}
              className={`opt opt--sm${unit === u.value ? ' is-active' : ''}`}
              aria-pressed={unit === u.value}
              // Named per field: two of these say "%", and "%" on its own tells a
              // screen reader nothing about which limit it switches.
              aria-label={`${label} in ${u.label}`}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>
      {isPercent ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={percentValue}
            onChange={(e) => onPercentChange(Number(e.target.value))}
            aria-label={`${label} percent`}
            style={{ flex: 1 }}
          />
          <span className="mono tnum" style={{ minWidth: 48, textAlign: 'right', fontSize: '.9rem', fontWeight: 600 }}>{percentValue}%</span>
        </div>
      ) : (
        <input
          className="input mono"
          type="number"
          min={0}
          step={absoluteStep}
          max={absoluteMax}
          value={absoluteValue}
          onChange={(e) => onAbsoluteChange(Number(e.target.value))}
          aria-label={label}
        />
      )}
      {note && <span className="subtle" style={{ display: 'block', marginTop: 6, fontSize: '.78rem' }}>{note}</span>}
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
