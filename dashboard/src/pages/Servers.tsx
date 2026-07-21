import { useCallback, useEffect, useState } from 'react';
import { listDeployments, stopDeployment, type DeploymentView } from '../api';
import { deploymentColor } from '../health';

// Servers: the live list of deployments. It polls the Orchestrator so status
// transitions (pending → running → stopped/crashed) show up on their own, and
// offers a Stop action on running servers.
const POLL_MS = 3000;

export function Servers() {
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDeployments(await listDeployments());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load deployments');
    }
  }, []);

  useEffect(() => {
    void load();
    const handle = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(handle);
  }, [load]);

  const onStop = async (id: string) => {
    try {
      await stopDeployment(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to stop deployment');
    }
  };

  return (
    <section style={{ padding: '1.5rem' }}>
      <h2>Servers</h2>
      {error ? (
        <p role="alert" style={{ color: '#dc2626' }}>{error}</p>
      ) : !deployments ? (
        <p>Loading…</p>
      ) : deployments.length === 0 ? (
        <p style={{ color: '#64748b' }}>No deployments yet. Create one from “New Deployment”.</p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>
              <th style={cell}>Name</th>
              <th style={cell}>Image</th>
              <th style={cell}>Node</th>
              <th style={cell}>Status</th>
              <th style={cell}>Container</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => (
              <tr key={d.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={cell}>{d.name}</td>
                <td style={cell}>{d.dockerImage}</td>
                <td style={cell}>{d.nodeId ?? '—'}</td>
                <td style={cell}>
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-block',
                      width: 9,
                      height: 9,
                      borderRadius: '50%',
                      background: deploymentColor(d.status),
                      marginRight: 6,
                    }}
                  />
                  {d.status}
                </td>
                <td style={{ ...cell, fontFamily: 'monospace' }}>
                  {d.containerId ? d.containerId.slice(0, 12) : '—'}
                </td>
                <td style={cell}>
                  {d.status === 'running' && (
                    <button onClick={() => onStop(d.id)} aria-label={`Stop ${d.name}`}>
                      Stop
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const cell = { padding: '0.5rem 0.75rem' };
