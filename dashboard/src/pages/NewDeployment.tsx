import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDeployment } from '../api';

// New Deployment form: image + optional port and env rows. On submit it creates
// the deployment (which places it on a node and starts the container) and jumps
// to the Servers list to watch it come up.
interface Row {
  key: string;
  value: string;
}

function rowsToRecord(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.key.trim()) out[r.key.trim()] = r.value.trim();
  }
  return out;
}

export function NewDeployment() {
  const [name, setName] = useState('');
  const [dockerImage, setDockerImage] = useState('');
  const [ports, setPorts] = useState<Row[]>([{ key: '', value: '' }]);
  const [env, setEnv] = useState<Row[]>([{ key: '', value: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createDeployment({
        name,
        dockerImage,
        ports: rowsToRecord(ports),
        env: rowsToRecord(env),
      });
      navigate('/servers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deployment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ padding: '1.5rem', maxWidth: 560 }}>
      <h2>New Deployment</h2>
      <form onSubmit={onSubmit}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
        </Field>
        <Field label="Docker image">
          <input
            value={dockerImage}
            onChange={(e) => setDockerImage(e.target.value)}
            placeholder="nginx"
            required
            style={inputStyle}
          />
        </Field>

        <RowEditor
          legend="Ports"
          hint="host : container"
          keyPlaceholder="8080"
          valuePlaceholder="80"
          rows={ports}
          onChange={setPorts}
        />
        <RowEditor
          legend="Environment"
          hint="KEY : value"
          keyPlaceholder="KEY"
          valuePlaceholder="value"
          rows={env}
          onChange={setEnv}
        />

        {error && (
          <p role="alert" style={{ color: '#dc2626' }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Deploying…' : 'Deploy'}
        </button>
      </form>
    </section>
  );
}

const inputStyle = { display: 'block', width: '100%', padding: '0.5rem', marginTop: '0.25rem' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: '0.75rem' }}>
      {label}
      {children}
    </label>
  );
}

function RowEditor({
  legend,
  hint,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  onChange,
}: {
  legend: string;
  hint: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
}) {
  const update = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <fieldset style={{ border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: '0.75rem' }}>
      <legend>
        {legend} <small style={{ color: '#64748b' }}>({hint})</small>
      </legend>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <input
            aria-label={`${legend} key ${i + 1}`}
            placeholder={keyPlaceholder}
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            style={{ flex: 1, padding: '0.4rem' }}
          />
          <input
            aria-label={`${legend} value ${i + 1}`}
            placeholder={valuePlaceholder}
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            style={{ flex: 1, padding: '0.4rem' }}
          />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        + Add {legend.toLowerCase()}
      </button>
    </fieldset>
  );
}
