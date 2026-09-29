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

describe('NodeDetail host ports (#233)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(platformRole: string) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const path = String(url);
      let body: unknown = [];
      if (path.endsWith('/nodes')) body = [{ ...node, portRangeStart: 30000, portRangeEnd: 30100 }];
      else if (path.includes('/deployments')) body = { items: deployments, total: deployments.length, limit: 200, offset: 0 };
      else if (path.endsWith('/me')) body = { id: 'u', email: 'a@b.c', displayName: 'A', platformRole, createdAt: '' };
      else if (path.endsWith('/nodes/node-1/ports') && init?.method === 'PATCH') body = { ...node, outsideRange: 2 };
      else if (path.endsWith('/nodes/node-1/ports')) body = [{ port: 30000, deploymentId: 'd1', name: 'my-nginx', primary: true }];
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('node-1');
    return fetchMock;
  }

  it('shows the pool and who holds what to an administrator', async () => {
    stub('admin');
    expect(await screen.findByText('my-nginx', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByLabelText('Port range start')).toHaveValue(30000);
  });

  it('hides it from everyone else', async () => {
    stub('user');
    await screen.findByText('Home box');
    expect(screen.queryByText('Host ports')).not.toBeInTheDocument();
  });

  it('saves a range and says what it left outside', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const { ToastProvider } = await import('../components/Toast');
    vi.unstubAllGlobals();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const path = String(url);
      let body: unknown = [];
      if (path.endsWith('/nodes')) body = [node];
      else if (path.includes('/deployments')) body = { items: [], total: 0, limit: 200, offset: 0 };
      else if (path.endsWith('/me')) body = { id: 'u', email: 'a@b.c', displayName: 'A', platformRole: 'owner', createdAt: '' };
      else if (path.endsWith('/nodes/node-1/ports') && init?.method === 'PATCH') body = { ...node, outsideRange: 2 };
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/nodes/node-1']}>
        <ToastProvider>
          <Routes>
            <Route path="/nodes/:id" element={<NodeDetail />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
    await userEvent.type(await screen.findByLabelText('Port range start'), '30000');
    await userEvent.type(screen.getByLabelText('Port range end'), '30100');
    await userEvent.click(screen.getByRole('button', { name: 'Save range' }));
    const patch = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith('/nodes/node-1/ports') && o?.method === 'PATCH');
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ range: { start: 30000, end: 30100 } });
    expect(await screen.findByText(/2 ports are already in use outside it and kept/)).toBeInTheDocument();
  });
});
