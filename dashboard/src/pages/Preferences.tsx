import { useState } from 'react';
import { getDeploymentDefaults, setDeploymentDefaults, resetDeploymentDefaults, DEFAULT_DEPLOYMENT, type DeploymentDefaults } from '../prefs';
import { InfoHint } from '../components/InfoHint';
import { useToast } from '../components/Toast';

// Preferences — customise the panel (#124). Currently the New Deployment defaults,
// persisted client-side so the form starts pre-filled the way you usually deploy.
export function Preferences() {
  const { toast } = useToast();
  const [d, setD] = useState<DeploymentDefaults>(() => getDeploymentDefaults());
  const set = <K extends keyof DeploymentDefaults>(k: K, v: DeploymentDefaults[K]) => setD((p) => ({ ...p, [k]: v }));

  const save = () => {
    setDeploymentDefaults(d);
    toast('Preferences saved', 'success', 'Preferences');
  };
  const reset = () => {
    resetDeploymentDefaults();
    setD({ ...DEFAULT_DEPLOYMENT });
    toast('Reverted to built-in defaults', 'info', 'Preferences');
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 24px', animation: 'rise 320ms var(--ease-out) both' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 6 }}>Preferences</h1>
      <p className="subtle" style={{ marginBottom: 24, fontSize: '.88rem' }}>
        Tailor the panel to how you work. These defaults pre-fill the New Deployment form.
      </p>

      <div className="card" style={{ padding: 24 }}>
        <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 16 }}>
          New Deployment defaults
          <InfoHint text="Every new deployment form starts with these values; you can still change them per deployment." label="Defaults help" />
        </strong>

        <Field label="Default type">
          <Seg options={[{ value: 'app', label: 'Application' }, { value: 'game', label: 'Game server' }]} value={d.type} onChange={(v) => set('type', v as DeploymentDefaults['type'])} />
        </Field>

        <PrefSlider label="CPU limit" value={d.cpu} onChange={(v) => set('cpu', v)} min={5} max={100} step={5} />
        <PrefSlider label="RAM limit" value={d.ram} onChange={(v) => set('ram', v)} min={5} max={100} step={5} />
        {/* No Disk limit here: it was never enforced, so a saved default for it
            would only pre-fill a control that does nothing (#276). */}
        <PrefSlider label="Swap (of RAM limit)" value={d.swap} onChange={(v) => set('swap', v)} min={0} max={100} step={25} />

        <Field label="Block I/O priority">
          <Seg options={['low', 'normal', 'high'].map((v) => ({ value: v, label: v }))} value={d.io} onChange={(v) => set('io', v as DeploymentDefaults['io'])} />
        </Field>
        <Field label="Restart policy">
          <Seg options={[{ value: 'no', label: 'Never' }, { value: 'on-failure', label: 'On failure' }, { value: 'always', label: 'Always' }]} value={d.restart} onChange={(v) => set('restart', v as DeploymentDefaults['restart'])} />
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', cursor: 'pointer', marginTop: 4 }}>
          <span style={{ fontSize: '.86rem', fontWeight: 550 }}>OOM killer by default</span>
          <button type="button" role="switch" aria-checked={d.oom} aria-label="OOM killer by default" onClick={() => set('oom', !d.oom)} style={{ flex: 'none', width: 44, height: 26, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer', padding: 3, transition: 'background 200ms', background: d.oom ? 'var(--color-primary)' : 'var(--color-border-strong)' }}>
            <span style={{ display: 'block', width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'transform 200ms var(--ease-out)', transform: d.oom ? 'translateX(18px)' : 'translateX(0)' }} />
          </button>
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
          <button className="btn btn--primary" data-ripple data-burst="success" onClick={save} style={{ minHeight: 42, padding: '0 20px' }}>Save preferences</button>
          <button className="btn btn--secondary" data-ripple onClick={reset} style={{ minHeight: 42 }}>Reset to defaults</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <span className="field__label" style={{ fontSize: '.86rem' }}>{label}</span>
      {children}
    </div>
  );
}

function Seg({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button key={o.value} type="button" data-ripple onClick={() => onChange(o.value)} className={`opt${o.value === value ? ' is-active' : ''}`} style={{ textTransform: 'capitalize' }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PrefSlider({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 9 }}>
        <span style={{ fontSize: '.86rem', fontWeight: 550 }}>{label}</span>
        <span className="mono" style={{ fontSize: '.9rem', fontWeight: 600, color: 'var(--color-primary)' }}>{value}%</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    </div>
  );
}
