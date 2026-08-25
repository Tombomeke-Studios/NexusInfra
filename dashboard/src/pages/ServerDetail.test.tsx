import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  ports: {},
  env: {},
  resourceLimits: {},
  autoRestart: false,
};

function renderDetail(role?: string, overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const path = String(url);
    // Tab content fetches its own data; an empty list keeps them quiet.
    const body =
      path.includes('/deployments/dep-1') && !path.includes('/deployments/dep-1/')
        ? { ...BASE, role, ...overrides }
        : [];
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

// Both tabs used to render a hardcoded array regardless of the server in front of
// you — two invented port allocations and an SFTP host nothing listens on (#217),
// and three invented environment variables (#218).

describe('ServerDetail Network tab', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("lists the server's own port mappings", async () => {
    renderDetail('owner', { ports: { '25565': '25000', '8080': '80' } });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));

    // Both sides of each mapping are shown, host port and container port.
    expect(screen.getByText('25565')).toBeInTheDocument();
    expect(screen.getByText('25000')).toBeInTheDocument();
    expect(screen.getByText('8080')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('says so plainly when no ports are published', async () => {
    renderDetail('owner', { ports: {} });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));

    expect(screen.getByText(/no published ports/i)).toBeInTheDocument();
  });

  it('does not advertise an SFTP endpoint that does not exist', async () => {
    renderDetail('owner', { ports: { '8080': '80' } });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));

    expect(screen.queryByText(/sftp\.nexusinfra\.local/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SFTP \/ FTP access/i)).not.toBeInTheDocument();
  });
});

// The panel used to answer a failed stream by inventing a replacement: drifting
// CPU/RAM/network meters (#250) and randomised log lines (#251), both indistinguishable
// from the real thing. The test fetch mock returns a body-less response, so every
// stream fails — which is exactly the condition that used to produce fiction.

describe('ServerDetail telemetry when the stream fails', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('reports the stats as unavailable instead of inventing numbers', async () => {
    renderDetail('owner');
    expect(await screen.findByText(/stats unavailable/i)).toBeInTheDocument();

    // CPU and Memory read as unknown — not as a plausible percentage.
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('offers no Disk, Players or TPS tile — nothing can measure them', async () => {
    renderDetail('owner', { type: 'game' });
    await screen.findByText(/stats unavailable/i);

    expect(screen.queryByText('Disk')).not.toBeInTheDocument();
    expect(screen.queryByText(/players/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/TPS/)).not.toBeInTheDocument();
  });

  it('says the log stream is unavailable rather than printing invented output', async () => {
    renderDetail('owner');
    // The message lands once the stream promise settles, which queues behind the
    // detail fetch and the stats stream.
    await waitFor(() => expect(screen.getByText(/the log stream is unavailable/i)).toBeInTheDocument(), { timeout: 4000 });

    // None of the generated lines the console used to emit.
    expect(screen.queryByText(/heartbeat ok/)).not.toBeInTheDocument();
    expect(screen.queryByText(/joined the game/)).not.toBeInTheDocument();
    expect(screen.queryByText(/streaming stdout/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cache hit ratio/)).not.toBeInTheDocument();
  });
});

describe('ServerDetail Settings tab', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  // The Reinstall button only ever fired a "Not wired yet" toast, and could not
  // mean anything: Start already recreates the container from the saved config
  // (#219). Offering no button beats offering one that does nothing.
  it('offers no Reinstall button', async () => {
    renderDetail('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

    expect(screen.queryByRole('button', { name: /reinstall/i })).not.toBeInTheDocument();
    // The real destructive action is still there.
    expect(screen.getByRole('button', { name: /delete server/i })).toBeInTheDocument();
  });
});

describe('ServerDetail Startup tab', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("lists the server's own environment variables", async () => {
    renderDetail('owner', { env: { LOG_LEVEL: 'debug', TZ: 'Europe/Brussels' } });
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));

    expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument();
    expect(screen.getByText('debug')).toBeInTheDocument();
    expect(screen.getByText('TZ')).toBeInTheDocument();
    expect(screen.getByText('Europe/Brussels')).toBeInTheDocument();
  });

  it('does not invent environment variables the server never had', async () => {
    renderDetail('owner', { env: {} });
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));

    expect(screen.queryByText('MAX_MEMORY')).not.toBeInTheDocument();
    expect(screen.queryByText('EULA')).not.toBeInTheDocument();
    expect(screen.getByText(/no environment variables/i)).toBeInTheDocument();
  });

  it('shows the image the server actually runs', async () => {
    renderDetail('owner', { dockerImage: 'itzg/minecraft-server:java21' });
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));

    expect(screen.getByText('itzg/minecraft-server:java21')).toBeInTheDocument();
  });
});
