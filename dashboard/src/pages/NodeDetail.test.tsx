import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { NodeDetail } from './NodeDetail';

const node = {
  id: 'node-1',
  name: 'Home box',
  location: 'home-server',
  lastHeartbeat: new Date().toISOString(),
  cpuPercent: 40,
  ramUsedMb: 2048,
  ramTotalMb: 4096,
  diskUsedGb: 20,
  diskTotalGb: 100,
  health: 'healthy',
};
const deployments = [
  { id: 'd1', name: 'my-nginx', dockerImage: 'nginx', type: 'app', nodeId: 'node-1', containerId: 'abc', status: 'running', startedAt: '', stoppedAt: null, createdAt: '' },
  { id: 'd2', name: 'elsewhere', dockerImage: 'redis', type: 'app', nodeId: 'node-2', containerId: null, status: 'stopped', startedAt: null, stoppedAt: '', createdAt: '' },
];

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/nodes/${id}`]}>
      <Routes>
        <Route path="/nodes/:id" element={<NodeDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('NodeDetail', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          typeof url === 'string' && url.includes('/nodes')
            ? [node]
            : // The list answers a page envelope now (#237).
              { items: deployments, total: deployments.length, limit: 200, offset: 0 },
      } as Response)
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the node with its location and only its own deployments', async () => {
    renderAt('node-1');
    expect(await screen.findByRole('heading', { name: 'Home box' })).toBeInTheDocument();
    expect(screen.getByText(/home-server/)).toBeInTheDocument();
    // Its server is listed; a server on another node is not.
    expect(screen.getByText('my-nginx')).toBeInTheDocument();
    expect(screen.queryByText('elsewhere')).toBeNull();
  });

  it('renders a not-found state for an unknown node', async () => {
    renderAt('ghost');
    expect(await screen.findByText('Node not found.')).toBeInTheDocument();
  });
});
