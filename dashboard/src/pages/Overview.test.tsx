import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Overview } from './Overview';

// Overview loads nodes + deployments from the API; the mocked fetch answers by
// URL so both requests resolve independently.
function jsonFor(url: string) {
  if (url.includes('/nodes')) {
    return [
      { id: 'node-local', name: 'node-local', health: 'healthy', cpuPercent: 12, ramUsedMb: 2000, ramTotalMb: 8000, lastHeartbeat: '', containerId: null, diskUsedGb: null, diskTotalGb: null },
    ];
  }
  return [
    { id: 'd1', name: 'my-nginx', dockerImage: 'nginx', nodeId: 'node-local', containerId: 'abc', status: 'running', startedAt: '', stoppedAt: null, createdAt: '' },
    { id: 'd2', name: 'old', dockerImage: 'nginx', nodeId: 'node-local', containerId: null, status: 'stopped', startedAt: '', stoppedAt: '', createdAt: '' },
  ];
}

describe('Overview', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, status: 200, json: async () => jsonFor(url) } as Response)
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the running-server count and a tile per node', async () => {
    render(<Overview />, { wrapper: MemoryRouter });

    // One of two deployments is running — assert the value on the running stat.
    const runningLabel = await screen.findByText('Running servers');
    expect(runningLabel.previousSibling).toHaveTextContent('1');
    expect(screen.getByText('node-local')).toBeInTheDocument();
  });

  // Maintenance used to be a useState in this component: the node was relabelled,
  // a toast claimed success, and the orchestrator kept placing servers there (#258).
  it('sends a real drain request when a node enters maintenance', async () => {
    render(<Overview />, { wrapper: MemoryRouter });
    await userEvent.click(await screen.findByRole('button', { name: /enter maintenance/i }));

    const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/nodes/node-local/maintenance') && o?.method === 'PATCH');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ maintenance: true });
  });

  it('reads the drain state from the API rather than from local state', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(url).includes('/nodes') ? jsonFor(url).map((n: Record<string, unknown>) => ({ ...n, maintenance: true })) : jsonFor(url)),
      } as Response)
    );
    render(<Overview />, { wrapper: MemoryRouter });

    // A node already draining when the page loads reads as such — the old
    // implementation always started empty, so a reload silently un-drained it.
    expect(await screen.findByText('maintenance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exit maintenance/i })).toBeInTheDocument();
  });
});
