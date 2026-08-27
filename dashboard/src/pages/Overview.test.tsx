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
  // The list answers a page envelope now (#237); the overview walks the pages.
  const items = [
    { id: 'd1', name: 'my-nginx', dockerImage: 'nginx', nodeId: 'node-local', containerId: 'abc', status: 'running', startedAt: '', stoppedAt: null, createdAt: '' },
    { id: 'd2', name: 'old', dockerImage: 'nginx', nodeId: 'node-local', containerId: null, status: 'stopped', startedAt: '', stoppedAt: '', createdAt: '' },
  ];
  return { items, total: items.length, limit: 200, offset: 0 };
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

  // The card used to derive a vCPU count from RAM and a "committed" figure from
  // the server count times an arbitrary constant (#261).
  it('shows the reported core count and the real committed caps', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes('/nodes')
            ? [{ id: 'node-local', name: 'node-local', health: 'healthy', cpuPercent: 12, cpuCores: 6, ramUsedMb: 2000, ramTotalMb: 8000, lastHeartbeat: '', diskUsedGb: null, diskTotalGb: null }]
            : {
                items: [
                  { id: 'd1', name: 'a', dockerImage: 'nginx', nodeId: 'node-local', containerId: 'c', status: 'running', startedAt: '', stoppedAt: null, createdAt: '', resourceLimits: { cpuPercent: 30, ramPercent: 25 } },
                  { id: 'd2', name: 'b', dockerImage: 'nginx', nodeId: 'node-local', containerId: 'c', status: 'running', startedAt: '', stoppedAt: null, createdAt: '', resourceLimits: { cpuPercent: 10, ramPercent: 5 } },
                ],
                total: 2,
                limit: 200,
                offset: 0,
              },
      } as Response)
    );
    render(<Overview />, { wrapper: MemoryRouter });

    expect(await screen.findByText('6 vCPU')).toBeInTheDocument();
    // 30+10 and 25+5 — not 2 servers x 22 / x 18.
    expect(screen.getByText('cpu 40% · ram 30%')).toBeInTheDocument();
  });

  it('shows no core count for a node that has not reported one', async () => {
    render(<Overview />, { wrapper: MemoryRouter });
    await screen.findByText('node-local');
    expect(screen.queryByText(/vCPU/)).not.toBeInTheDocument();
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
  // Consumers dead-letter on failure and nothing read that queue, so events could
  // pile up unnoticed indefinitely (#243).
  it('warns when events are stuck in the dead-letter queue', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes('/monitoring')
            ? { monitored: [], reachable: true, deadLetters: { status: 'messages-waiting', depth: 3 } }
            : jsonFor(url),
      } as Response)
    );
    render(<Overview />, { wrapper: MemoryRouter });

    expect(await screen.findByText(/could not be processed/)).toBeInTheDocument();
  });

  it('says nothing at all when the queue is empty', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes('/monitoring')
            ? { monitored: [], reachable: true, deadLetters: { status: 'empty', depth: 0 } }
            : jsonFor(url),
      } as Response)
    );
    render(<Overview />, { wrapper: MemoryRouter });
    await screen.findByText('node-local');

    // A healthy queue does not need a line of its own.
    expect(screen.queryByText(/dead-letter queue/)).not.toBeInTheDocument();
  });
});
