import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ServerDetail } from './ServerDetail';
import { ToastProvider } from '../components/Toast';

// The detail view offers only the actions the caller's role allows (#178). The
// API enforces this regardless — these tests are about not presenting a button
// that would come back refused.

const BASE = {
  id: 'dep-1',
  name: 'shared-svc',
  dockerImage: 'nginx',
  type: 'generic',
  nodeId: 'node-local',
  containerId: 'c1',
  status: 'running',
  startedAt: null,
  stoppedAt: null,
  createdAt: new Date().toISOString(),
  events: [],
};

function renderDetail(role?: string) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    // Tab content fetches its own data; an empty list keeps them quiet.
    const body = path.includes('/deployments/dep-1') && !path.includes('/deployments/dep-1/') ? { ...BASE, role } : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(
    <MemoryRouter initialEntries={['/servers/dep-1']}>
      <ToastProvider>
        <Routes>
          <Route path="/servers/:id" element={<ServerDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('ServerDetail access gating', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('gives the owner every control and tab', async () => {
    renderDetail('owner');
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'subusers' })).toBeInTheDocument();
    // The owner is not told their own role — it's their server.
    expect(screen.queryByText(/Your role:/)).not.toBeInTheDocument();
  });

  it('lets an operator run the server without managing it', async () => {
    renderDetail('operator');
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    expect(screen.getByText('Your role: Operator')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'subusers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'backups' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'databases' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settings' })).not.toBeInTheDocument();
  });

  it('gives a viewer no controls at all', async () => {
    renderDetail('viewer');
    expect(await screen.findByText('Your role: Viewer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'terminal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'files' })).not.toBeInTheDocument();
  });

  it('opens a tab the role can actually use when the default one is hidden', async () => {
    // A viewer cannot open the console's sibling tabs; the panel must not render
    // an empty body because the default tab happens to be unavailable.
    renderDetail('viewer');
    expect(await screen.findByRole('button', { name: 'console' })).toBeInTheDocument();
  });

  it('assumes full access when the API returns no role', async () => {
    // Older responses carry no role; hiding controls from an owner would leave
    // them unable to act on their own server.
    renderDetail(undefined);
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings' })).toBeInTheDocument();
  });
});
