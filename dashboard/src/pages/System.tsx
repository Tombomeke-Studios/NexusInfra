import { useCallback, useEffect, useState } from 'react';
import { getSystemReport, ApiError, type SystemReport, type SystemFeature } from '../api';
import { APP_VERSION } from '../appVersion';

// System (#447) — what each part of this installation runs, and which optional
// features are on. For platform administrators; the API answers 403 to anyone
// else, and the nav hides the link, which is convenience only.
//
// It exists because "I updated and the new features are not there" had two
// causes nobody could see from the panel: images still on the old release, and
// a compose file that did not pass the variables a feature needs. The page names
// those variables; it never shows a value.

const STATE_LABEL: Record<SystemFeature['state'], string> = { on: 'On', off: 'Off', warning: 'Check' };
const STATE_BADGE: Record<SystemFeature['state'], string> = { on: 'badge--success', off: 'badge--neutral', warning: 'badge--warning' };

export function System() {
  const [report, setReport] = useState<SystemReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await getSystemReport());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? 'Only platform administrators can see this page.' : e instanceof Error ? e.message : 'Could not load the system report');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const warnings = report?.features.filter((f) => f.state === 'warning') ?? [];

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 24px 48px' }}>
      <h1 style={{ marginBottom: 6 }}>System</h1>
      <p className="subtle" style={{ marginTop: 0 }}>
        Which release each part of this installation runs, and which optional features are on. Features are turned on by
        settings in the stack’s <code>.env</code>; this page names them but never shows their values.
      </p>
      <button className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={busy} style={{ marginBottom: 16 }}>
        {busy ? 'Checking…' : 'Check again'}
      </button>
      {error && (
        <p role="alert" className="alert alert--error">
          {error}
        </p>
      )}
      {report && (
        <>
          {report.versionProblem && (
            <div role="alert" className="alert alert--warning" style={{ marginBottom: 16 }}>
              {report.versionProblem}
            </div>
          )}
          {warnings.length > 0 && (
            <div role="status" className="alert alert--warning" style={{ marginBottom: 16 }}>
              {warnings.length === 1 ? 'One setting needs' : `${warnings.length} settings need`} attention: {warnings.map((w) => w.label).join(', ')}.
            </div>
          )}

          <section className="card" style={{ padding: '18px 22px', marginBottom: 22, position: 'relative', overflowX: 'auto' }}>
            <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Components</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.88rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-soft)' }}>
                  <th style={{ padding: '6px 8px' }}>Part</th>
                  <th style={{ padding: '6px 8px' }}>Version</th>
                  <th style={{ padding: '6px 8px' }}>Edition</th>
                  <th style={{ padding: '6px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: '6px 8px' }}>Panel (this page)</td>
                  <td style={{ padding: '6px 8px' }} className="mono">{APP_VERSION}</td>
                  <td style={{ padding: '6px 8px' }}>—</td>
                  <td style={{ padding: '6px 8px' }}>
                    <span className="badge badge--success">Loaded</span>
                  </td>
                </tr>
                {report.components.map((c) => (
                  <tr key={`${c.service}:${c.nodeId ?? ''}`}>
                    <td style={{ padding: '6px 8px' }}>{c.label}</td>
                    <td style={{ padding: '6px 8px' }} className="mono">{c.version ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{c.edition ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {c.reachable ? <span className="badge badge--success">Answering</span> : <span className="badge badge--danger">Not answering</span>}
                      {c.problem && <span className="subtle" style={{ marginLeft: 8, fontSize: '.8rem' }}>{c.problem}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card" style={{ padding: '18px 22px' }}>
            <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Features and settings</h2>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {report.features.map((f) => (
                <li key={f.id} style={{ padding: '10px 0', borderTop: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{f.label}</strong>
                    <span className={`badge ${STATE_BADGE[f.state]}`}>{STATE_LABEL[f.state]}</span>
                  </div>
                  <p style={{ margin: '4px 0 0', fontSize: '.86rem' }}>{f.summary}</p>
                  <p className="subtle" style={{ margin: '2px 0 0', fontSize: '.78rem' }}>
                    {f.variables.length === 1 ? 'Setting' : 'Settings'}: {f.variables.map((v) => <code key={v} style={{ marginRight: 6 }}>{v}</code>)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
