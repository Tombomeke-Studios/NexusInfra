import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ServerDetail } from './ServerDetail';
import { ToastProvider } from '../components/Toast';
import { DialogProvider } from '../components/Dialog';

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
        <DialogProvider>
          <Routes>
            <Route path="/servers/:id" element={<ServerDetail />} />
          </Routes>
        </DialogProvider>
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

  it("shows the disk the node measured, with what it is made of (#347)", async () => {
    renderDetail('owner');
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url, init) =>
      String(url).endsWith('/deployments/dep-1/disk')
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({ deploymentId: 'dep-1', measuredAt: new Date().toISOString(), volumesBytes: 3 * 1024 ** 3, writableBytes: 512 * 1024, volumes: [] }) } as Response)
        : base(url, init)
    );
    cleanup();
    render(
      <MemoryRouter initialEntries={['/servers/dep-1']}>
        <ToastProvider>
          <Routes>
            <Route path="/servers/:id" element={<ServerDetail />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText('3 GB')).toBeInTheDocument();
    expect(screen.getByText('data 3 GB · layer 512 KB')).toBeInTheDocument();
  });

  it('offers no Players or TPS tile — nothing can measure them', async () => {
    renderDetail('owner', { type: 'game' });
    await screen.findByText(/stats unavailable/i);

    // Disk used to be absent for the same reason; the node measures it now (#347).
    expect(screen.getByText('Disk')).toBeInTheDocument();
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

// The trail has been written since the beginning and nothing ever read it back,
// so "who stopped my server" was unanswerable from the panel (#223).
describe('ServerDetail Activity tab', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('renders the audit trail', async () => {
    const events = [
      { id: 'e2', event: 'stop-requested', message: 'stop requested by user', timestamp: '2026-08-26T10:00:00.000Z' },
      { id: 'e1', event: 'created', message: 'placed on node node-local', timestamp: '2026-08-26T09:00:00.000Z' },
    ];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const path = String(url);
      const body = path.includes('/deployments/dep-1/events') ? events : path.includes('/deployments/dep-1/') ? [] : { ...BASE, role: 'owner' };
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/servers/dep-1']}>
        <ToastProvider>
          <DialogProvider>
            <Routes>
              <Route path="/servers/:id" element={<ServerDetail />} />
            </Routes>
          </DialogProvider>
        </ToastProvider>
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByRole('button', { name: 'activity' }));

    expect(await screen.findByText('stop-requested')).toBeInTheDocument();
    expect(screen.getByText('placed on node node-local')).toBeInTheDocument();
  });

  it('says so when nothing has happened yet', async () => {
    renderDetail('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'activity' }));
    expect(await screen.findByText(/nothing has happened/i)).toBeInTheDocument();
  });
});

describe('ServerDetail Settings tab', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  // The Reinstall button only ever fired a "Not wired yet" toast, and could not
  // mean anything: Start already recreates the container from the saved config
  // (#219). Offering no button beats offering one that does nothing.
  // A server's configuration was frozen at creation: fixing a typo in a name meant
  // deleting the server, and its databases and backups went with it (#220).
  it('saves a configuration change without restarting anything', async () => {
    renderDetail('owner', { name: 'old-name', env: { A: '1' } });
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

    const nameInput = await screen.findByLabelText('Name');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'new-name');
    await userEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    const patch = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls.find(
      ([u, o]) => String(u).includes('/deployments/dep-1') && o?.method === 'PATCH'
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch![1].body as string)).toMatchObject({ name: 'new-name', env: { A: '1' } });
  });

  it('saves which directories survive a restart (#324)', async () => {
    renderDetail('owner', { name: 'web', env: {}, persistPaths: ['/srv'] });
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

    const field = await screen.findByPlaceholderText('/data, /var/lib/app');
    expect(field).toHaveValue('/srv');
    await userEvent.clear(field);
    await userEvent.type(field, '/srv, /var/lib/app');
    await userEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    const patch = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls.find(
      ([u, o]) => String(u).includes('/deployments/dep-1') && o?.method === 'PATCH'
    );
    expect(JSON.parse(patch![1].body as string).persistPaths).toEqual(['/srv', '/var/lib/app']);
  });

  // An egg server was created with a proper form and then edited as raw JSON, with
  // no labels, no validation and nothing stopping you deleting EULA (#272).
  describe('an egg server', () => {
    const EGG = {
      id: 'minecraft-java',
      name: 'Minecraft (Java Edition)',
      description: 'A Java Edition server.',
      dockerImage: 'itzg/minecraft-server',
      ports: { '25565': '25565' },
      dataPath: '/data',
      variables: [
        { key: 'MAX_PLAYERS', label: 'Player slots', description: 'How many people may connect at once.', kind: 'integer', default: '20', min: 1, max: 200 },
        { key: 'MOTD', label: 'Server description', description: 'Shown in the multiplayer list.', kind: 'string', default: 'A NexusInfra server' },
      ],
    };

    function renderEggServer() {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        const path = String(url);
        if (path.includes('/eggs')) return Promise.resolve({ ok: true, status: 200, json: async () => [EGG] } as Response);
        const body =
          path.includes('/deployments/dep-1') && !path.includes('/deployments/dep-1/')
            ? { ...BASE, role: 'owner', type: 'minecraft-java', ports: { '25565': '25565' }, env: { MAX_PLAYERS: '20', MOTD: 'hello' } }
            : [];
        return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
      });
      vi.stubGlobal('fetch', fetchMock);

      render(
        <MemoryRouter initialEntries={['/servers/dep-1']}>
          <ToastProvider>
            <DialogProvider>
              <Routes>
                <Route path="/servers/:id" element={<ServerDetail />} />
              </Routes>
            </DialogProvider>
          </ToastProvider>
        </MemoryRouter>
      );
      return fetchMock;
    }

    it('is edited through the egg fields, not a JSON textarea', async () => {
      renderEggServer();
      await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

      // Labelled and described, exactly as at creation.
      expect(await screen.findByRole('spinbutton', { name: /player slots/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /server description/i })).toBeInTheDocument();
      expect(screen.queryByLabelText(/Environment \(as JSON\)/)).not.toBeInTheDocument();
    });

    it('offers the public port as its own field', async () => {
      renderEggServer();
      await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

      // The one field someone forwarding a port on their router needs.
      const port = await screen.findByRole('textbox', { name: /public port/i });
      expect(port).toHaveValue('25565');
    });

    it('sends the answers as eggValues so the egg validates them', async () => {
      const fetchMock = renderEggServer();
      await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

      const slots = await screen.findByRole('spinbutton', { name: /player slots/i });
      await userEvent.clear(slots);
      await userEvent.type(slots, '40');
      await userEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const patch = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/deployments/dep-1') && o?.method === 'PATCH');
      expect(patch).toBeDefined();
      const body = JSON.parse(patch![1].body as string);
      expect(body.eggValues).toMatchObject({ MAX_PLAYERS: '40' });
      // The egg owns the image and environment; sending them would be ignored.
      expect(body.dockerImage).toBeUndefined();
      expect(body.env).toBeUndefined();
    });

    it('sends a changed public port as the host side of the mapping', async () => {
      const fetchMock = renderEggServer();
      await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

      const port = await screen.findByRole('textbox', { name: /public port/i });
      await userEvent.clear(port);
      await userEvent.type(port, '25570');
      await userEvent.click(screen.getByRole('button', { name: /save configuration/i }));

      const patch = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/deployments/dep-1') && o?.method === 'PATCH');
      expect(JSON.parse(patch![1].body as string).ports).toEqual({ '25570': '25565' });
    });
  });

  it('refuses malformed JSON without calling the API', async () => {
    renderDetail('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));

    const envInput = await screen.findByLabelText(/environment/i);
    await userEvent.clear(envInput);
    await userEvent.type(envInput, '{{not json');
    await userEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls;
    expect(calls.some(([, o]) => o?.method === 'PATCH')).toBe(false);
  });

  it('does not offer the editor to an operator', async () => {
    // An operator may run the server; redefining it is an admin's business.
    renderDetail('operator');
    await screen.findByText('Your role: Operator');
    expect(screen.queryByRole('button', { name: 'settings' })).not.toBeInTheDocument();
  });

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

describe('ServerDetail ownership transfer (#230)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const openSettings = async () => userEvent.click(await screen.findByRole('button', { name: 'settings' }));

  it('offers the owner a transfer form', async () => {
    renderDetail('owner');
    await openSettings();
    expect(await screen.findByRole('textbox', { name: /email of the new owner/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /transfer server/i })).toBeInTheDocument();
  });

  it('sends the address and what the outgoing owner keeps', async () => {
    renderDetail('owner');
    await openSettings();

    await userEvent.type(await screen.findByRole('textbox', { name: /email of the new owner/i }), 'heir@example.com');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /what you keep/i }), 'viewer');
    await userEvent.click(screen.getByRole('button', { name: /transfer server/i }));

    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls;
    const post = calls.find(([u, o]) => String(u).includes('/deployments/dep-1/transfer') && o?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post![1].body as string)).toEqual({ email: 'heir@example.com', retainRole: 'viewer' });
  });

  it('sends a null retained role when the owner keeps nothing', async () => {
    renderDetail('owner');
    await openSettings();

    await userEvent.type(await screen.findByRole('textbox', { name: /email of the new owner/i }), 'heir@example.com');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /what you keep/i }), '');
    await userEvent.click(screen.getByRole('button', { name: /transfer server/i }));

    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }][] } }).mock.calls;
    const post = calls.find(([u, o]) => String(u).includes('/deployments/dep-1/transfer') && o?.method === 'POST');
    expect(JSON.parse(post![1].body as string).retainRole).toBeNull();
  });

  it('does not offer it to a server admin, who cannot transfer', async () => {
    // The Settings tab itself is owner-only, so this is belt and braces — the
    // panel must not present an action the API answers with 403.
    renderDetail('admin');
    await screen.findByText('Your role: Admin');
    expect(screen.queryByRole('button', { name: /transfer server/i })).not.toBeInTheDocument();
  });
});

describe('ServerDetail destructive actions ask first (#299)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('does not delete until the dialog is confirmed, and names the server in it', async () => {
    renderDetail('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));
    await userEvent.click(screen.getByRole('button', { name: /delete server/i }));

    // The dialog names the server and what goes with it — the native one gave
    // this the same single line as renaming a file.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName(/shared-svc/);
    expect(screen.getByText(/its files, its databases and its backups/i)).toBeInTheDocument();

    const calls = () => (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls;
    expect(calls().some(([, o]) => o?.method === 'DELETE')).toBe(false);

    await userEvent.click(screen.getAllByRole('button', { name: /delete server/i }).pop()!);
    expect(calls().some(([u, o]) => String(u).includes('/deployments/dep-1') && o?.method === 'DELETE')).toBe(true);
  });

  it('deletes nothing when the dialog is cancelled', async () => {
    renderDetail('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));
    await userEvent.click(screen.getByRole('button', { name: /delete server/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, { method?: string }][] } }).mock.calls;
    expect(calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);
  });
});

describe('ServerDetail Network tab shows the protocol (#313)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('says UDP where the mapping is UDP, rather than implying TCP', async () => {
    // The protocol is the thing somebody forwarding a port on their router has
    // to get right: a TCP rule for a UDP game forwards nothing.
    renderDetail('owner', { ports: { '2456': '2456/udp', '2457': '2457/udp' } });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));

    expect(await screen.findAllByText('UDP')).toHaveLength(2);
    // Both the host side and the container side are still shown.
    expect(screen.getAllByText('2456').length).toBeGreaterThan(0);
  });

  it('shows both protocols for a port published on each', async () => {
    renderDetail('owner', { ports: { '27015': '27015/tcp+udp' } });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));

    expect(await screen.findByText('TCP + UDP')).toBeInTheDocument();
  });

  it('still reads a bare port as TCP, as it always did', async () => {
    renderDetail('owner', { ports: { '25565': '25565' } });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));

    expect(await screen.findByText('TCP')).toBeInTheDocument();
  });
});

describe('ServerDetail image updates (#239)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function stubWithImage(role: string, imageBody: unknown = { image: 'nginx', status: 'update-available', remoteDigest: 'sha256:b', localDigest: 'sha256:a', checkedAt: '' }) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      let body: unknown = [];
      if (path.endsWith('/deployments/dep-1')) body = { ...BASE, role };
      else if (path.endsWith('/deployments/dep-1/image')) body = imageBody;
      else if (path.endsWith('/deployments/dep-1/update') && init?.method === 'POST') body = { status: 'updating', recreate: true };
      return Promise.resolve({ ok: true, status: path.endsWith('/update') ? 202 : 200, json: async () => body } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/servers/dep-1']}>
        <ToastProvider>
          <DialogProvider>
            <Routes>
              <Route path="/servers/:id" element={<ServerDetail />} />
            </Routes>
          </DialogProvider>
        </ToastProvider>
      </MemoryRouter>
    );
    return fetchMock;
  }

  it('checks the registry on demand and says what it found', async () => {
    stubWithImage('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('A newer image is available for this tag.')).toBeInTheDocument();
  });

  it('does not call an unreachable registry "up to date"', async () => {
    stubWithImage('owner', { image: 'nginx', status: 'unknown', remoteDigest: null, localDigest: 'sha256:a', checkedAt: '' });
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText(/not known to be current/)).toBeInTheDocument();
  });

  it('updates and recreates a running server', async () => {
    const fetchMock = stubWithImage('owner');
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));
    await userEvent.click(screen.getByRole('button', { name: 'Update and recreate' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/deployments/dep-1/update') && o?.method === 'POST')).toBe(true)
    );
    expect(await screen.findByText(/Its data is kept/)).toBeInTheDocument();
  });

  it('lets an operator check but not update', async () => {
    stubWithImage('operator');
    await userEvent.click(await screen.findByRole('button', { name: 'startup' }));
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update and recreate' })).not.toBeInTheDocument();
  });
});

describe('ServerDetail backups (#232)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const BACKUPS = [
    { id: 'b1', deploymentId: 'dep-1', name: 'backup-1', path: '/data', sizeBytes: 2048, status: 'ready', createdAt: '', offsite: 'stored' },
    { id: 'b2', deploymentId: 'dep-1', name: 'backup-2', path: '/data', sizeBytes: 2048, status: 'ready', createdAt: '', offsite: 'failed' },
  ];

  function stubBackups(retention: Record<string, number> = {}) {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/deployments/dep-1')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...BASE, role: 'owner', backupRetention: retention }) } as Response);
      if (path.endsWith('/backups/retention') && init?.method === 'PUT') return Promise.resolve({ ok: true, status: 200, json: async () => ({ backupRetention: JSON.parse(String(init.body)), expired: 1 }) } as Response);
      if (path.endsWith('/backups/b1/download'))
        return Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'content-disposition': 'attachment; filename="web-backup-1.tar"' }), blob: async () => new Blob(['tar']) } as unknown as Response);
      if (path.endsWith('/backups')) return Promise.resolve({ ok: true, status: 200, json: async () => BACKUPS } as Response);
      return Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/servers/dep-1']}>
        <ToastProvider>
          <DialogProvider>
            <Routes>
              <Route path="/servers/:id" element={<ServerDetail />} />
            </Routes>
          </DialogProvider>
        </ToastProvider>
      </MemoryRouter>
    );
    return fetchMock;
  }

  it('says which backups made it off the node, and which did not', async () => {
    stubBackups();
    await userEvent.click(await screen.findByRole('button', { name: 'backups' }));
    expect(await screen.findByText('copied off-site')).toBeInTheDocument();
    expect(screen.getByText(/on the node only/)).toBeInTheDocument();
  });

  it('saves a retention policy, blank meaning no limit', async () => {
    const fetchMock = stubBackups({ keepDays: 30 });
    await userEvent.click(await screen.findByRole('button', { name: 'backups' }));
    expect(await screen.findByLabelText('Keep backups for N days')).toHaveValue(30);
    await userEvent.type(screen.getByLabelText('Keep the last N backups'), '7');
    await userEvent.clear(screen.getByLabelText('Keep backups for N days'));
    await userEvent.click(screen.getByRole('button', { name: 'Save retention' }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith('/backups/retention') && o?.method === 'PUT');
      expect(JSON.parse(String(put![1].body))).toEqual({ keepLast: 7, keepDays: null });
    });
    expect(await screen.findByText(/1 old backup was removed/)).toBeInTheDocument();
  });

  // #342: a server with no data directory of its own fell back to /data, and
  // the tab only reported Docker's "no such container".
  it('asks which directory to back up when the server has none of its own', async () => {
    const fetchMock = stubBackups();
    const posts: unknown[] = [];
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/backups') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (!body.path) return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'nothing at /data in this server — name a directory to back up', path: '/data' }) } as Response);
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ ...BACKUPS[0], name: 'backup-3', path: body.path }) } as Response);
      }
      return base(url, init);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'backups' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create backup' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/^Nothing at \/data in this server\. Name the directory/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Directory'), '/usr/share/nginx/html');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back up' }));

    await waitFor(() => expect(posts).toEqual([{}, { path: '/usr/share/nginx/html' }]));
    expect(await screen.findByText(/Backup backup-3 created/)).toBeInTheDocument();
  });

  it('downloads a backup as a file', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    stubBackups();
    await userEvent.click(await screen.findByRole('button', { name: 'backups' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Download backup-1' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe('ServerDetail moving a server (#234)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  const NODES = [
    { id: 'node-local', name: 'node-local', health: 'healthy', maintenance: false },
    { id: 'node-b', name: 'Node B', location: 'Ghent', health: 'healthy', maintenance: false },
    { id: 'node-c', name: 'Node C', health: 'offline', maintenance: false },
  ];

  function stubAs(platformRole: string, status = 'stopped') {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      let body: unknown = [];
      if (path.endsWith('/deployments/dep-1')) body = { ...BASE, status, containerId: null, role: 'owner' };
      else if (path.endsWith('/me')) body = { id: 'u', email: 'a@b.c', displayName: 'A', platformRole, createdAt: '' };
      else if (path.endsWith('/nodes')) body = NODES;
      else if (path.endsWith('/migrate') && init?.method === 'POST') body = { status: 'migrating', nodeId: 'node-b' };
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/servers/dep-1']}>
        <ToastProvider>
          <DialogProvider>
            <Routes>
              <Route path="/servers/:id" element={<ServerDetail />} />
            </Routes>
          </DialogProvider>
        </ToastProvider>
      </MemoryRouter>
    );
    return fetchMock;
  }

  it('is not offered to someone who is not a platform administrator', async () => {
    stubAs('user');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));
    await screen.findByText('Share with a team');
    expect(screen.queryByText('Move to another node')).not.toBeInTheDocument();
  });

  it('offers only other healthy nodes, and moves after confirmation', async () => {
    const fetchMock = stubAs('admin');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));
    const select = await screen.findByLabelText('Node to move to');
    const options = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['', 'node-b']);

    await userEvent.selectOptions(select, 'node-b');
    await userEvent.click(screen.getByRole('button', { name: 'Move server' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move server' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith('/deployments/dep-1/migrate') && o?.method === 'POST');
      expect(JSON.parse(String(call![1].body))).toEqual({ nodeId: 'node-b' });
    });
  });

  it('asks for the server to be stopped first', async () => {
    stubAs('admin', 'running');
    await userEvent.click(await screen.findByRole('button', { name: 'settings' }));
    expect(await screen.findByText(/Stop the server to move it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move server' })).toBeDisabled();
  });
});

describe('ServerDetail primary port (#233)', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('lists the primary port first and lets an admin choose another', async () => {
    renderDetail('owner', {
      ports: { '27015': '27015/udp', '27016': '27016/tcp' },
      portAllocations: [
        { port: 27015, primary: false },
        { port: 27016, primary: true },
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));
    const rows = await screen.findAllByText(/^2701[56]$/, { selector: '.mono' });
    expect(rows[0]).toHaveTextContent('27016');
    expect(screen.getByText('Primary')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Make 27015 the primary port' }));
    await waitFor(() => {
      const put = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(
        ([u, o]) => String(u).endsWith('/ports/primary') && o?.method === 'PUT'
      );
      expect(JSON.parse(String(put![1]!.body))).toEqual({ port: 27015 });
    });
  });

  it('offers no choice to a role that cannot edit the server', async () => {
    renderDetail('viewer', { ports: { '1': '1', '2': '2' }, portAllocations: [{ port: 1, primary: true }, { port: 2, primary: false }] });
    await userEvent.click(await screen.findByRole('button', { name: 'network' }));
    expect(screen.queryByRole('button', { name: /Make .* the primary port/ })).not.toBeInTheDocument();
  });
});
