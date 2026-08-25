import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
