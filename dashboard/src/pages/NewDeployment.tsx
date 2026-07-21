import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createDeployment } from '../api';
import { IconPlus } from '../components/Icons';
import { useToast } from '../components/Toast';

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
  const { toast } = useToast();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createDeployment({ name, dockerImage, ports: rowsToRecord(ports), env: rowsToRecord(env) });
      toast(`Deploying ${name}`, 'success');
      navigate('/servers');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deployment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page__head">
        <h1 className="page__title">New Deployment</h1>
      </div>

      <div className="card">
        <div className="card__body">
          <form onSubmit={onSubmit}>
            <label className="field">
              <span className="field__label">
                Name <span className="field__req">*</span>
              </span>
              <input
                className="input"
                aria-label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-nginx"
                required
              />
            </label>

            <label className="field">
              <span className="field__label">
                Docker image <span className="field__req">*</span>
              </span>
              <input
                className="input"
                aria-label="Docker image"
                value={dockerImage}
                onChange={(e) => setDockerImage(e.target.value)}
                placeholder="nginx"
                required
              />
              <span className="field__hint">Any image your nodes can pull, e.g. nginx, redis, ghcr.io/org/app.</span>
            </label>

            <RowEditor legend="Ports" hint="host : container" keyPlaceholder="8080" valuePlaceholder="80" rows={ports} onChange={setPorts} />
            <RowEditor legend="Environment" hint="KEY : value" keyPlaceholder="KEY" valuePlaceholder="value" rows={env} onChange={setEnv} />

            {error && (
              <p role="alert" className="alert alert--error" style={{ marginBottom: 'var(--space-4)' }}>
                {error}
              </p>
            )}

            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy && <span className="spinner" />}
              {busy ? 'Deploying…' : 'Deploy'}
            </button>
          </form>
        </div>
      </div>
    </div>
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
  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [{ key: '', value: '' }]);

  return (
    <div className="field">
      <span className="field__label">
        {legend} <span className="subtle" style={{ fontWeight: 400 }}>({hint})</span>
      </span>
      <div className="stack">
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
            <input
              className="input"
              aria-label={`${legend} key ${i + 1}`}
              placeholder={keyPlaceholder}
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <input
              className="input"
              aria-label={`${legend} value ${i + 1}`}
              placeholder={valuePlaceholder}
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            <button type="button" className="icon-btn" onClick={() => remove(i)} aria-label={`Remove ${legend.toLowerCase()} row ${i + 1}`}>
              −
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        style={{ marginTop: 'var(--space-2)' }}
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        <IconPlus size={15} />
        Add {legend.toLowerCase()}
      </button>
    </div>
  );
}
