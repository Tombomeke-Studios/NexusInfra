import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { NewDeployment } from './NewDeployment';

// The catalogue the orchestrator serves (#231). The form renders itself from this,
// so a new egg needs no dashboard change — and these tests assert exactly that.
const MINECRAFT_EGG = {
  id: 'minecraft-java',
  name: 'Minecraft (Java Edition)',
  description: 'A Java Edition server built on itzg/minecraft-server.',
  dockerImage: 'itzg/minecraft-server',
  ports: { '25565': '25565' },
  dataPath: '/data',
  memoryVariable: 'MEMORY',
  variables: [
    { key: 'MEMORY', label: 'Java heap size', description: 'How much memory the server may actually use.', kind: 'string', default: '2G' },
    { key: 'TYPE', label: 'Server software', description: 'Which server software to run.', kind: 'choice', default: 'VANILLA', options: ['VANILLA', 'PAPER'] },
    { key: 'MAX_PLAYERS', label: 'Player slots', description: 'How many people may connect at once.', kind: 'integer', default: '20', min: 1, max: 200 },
    { key: 'ONLINE_MODE', label: 'Verify accounts with Mojang', description: 'Whether joining requires a paid account.', kind: 'boolean', default: 'true' },
  ],
};

// Filling the form and submitting should POST a deployment with the parsed
// ports/env and then navigate to the servers list.
function renderForm() {
  return render(
    <MemoryRouter initialEntries={['/new']}>
      <Routes>
        <Route path="/new" element={<NewDeployment />} />
        <Route path="/servers" element={<div>Servers page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('NewDeployment', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear(); // don't let a prior test's POST leak into calls[]
    // The form fetches nodes on mount (placement options); answer that with [].
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/nodes')) return Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response);
      if (path.includes('/eggs')) return Promise.resolve({ ok: true, status: 200, json: async () => [MINECRAFT_EGG] } as Response);
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('submits the parsed deployment and navigates to servers', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText('Name'), 'my-nginx');
    await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
    await userEvent.type(screen.getByLabelText('Ports key 1'), '8080');
    await userEvent.type(screen.getByLabelText('Ports value 1'), '80');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST'
    );
    expect(call).toBeDefined();
    // The full config is sent: parsed ports/env plus the kind, restart flag and
    // the resource limits at their default control values (#106).
    expect(JSON.parse(call![1].body as string)).toEqual({
      name: 'my-nginx',
      dockerImage: 'nginx',
      ports: { '8080': '80' },
      env: {},
      type: 'app',
      autoRestart: true,
      resourceLimits: {
        cpuPercent: 50,
        ramPercent: 50,
        diskPercent: 50,
        swapPercent: 0,
        ioPriority: 'normal',
        restartPolicy: 'on-failure',
        oomKill: false,
      },
    });
  });

  it('deploys from an egg by id, letting the server derive the image', async () => {
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /Game server/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'mc');
    await screen.findByRole('button', { name: /Java Edition/ });
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST');
    const body = JSON.parse(call![1].body as string);

    // The recipe lives on the server: the panel sends which egg, not which image.
    expect(body.eggId).toBe('minecraft-java');
    expect(body.dockerImage).toBeUndefined();
  });

  it('renders a field per egg variable and sends the answers', async () => {
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /Game server/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'mc');

    // The fields come from the catalogue, not from anything hardcoded here.
    await userEvent.click(await screen.findByRole('button', { name: 'PAPER' }));
    const slots = screen.getByRole('spinbutton');
    await userEvent.clear(slots);
    await userEvent.type(slots, '40');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST');
    expect(JSON.parse(call![1].body as string).eggValues).toMatchObject({ TYPE: 'PAPER', MAX_PLAYERS: '40' });
  });

  it('offers no free-form environment rows for an egg', async () => {
    // The egg owns its environment; arbitrary rows would defeat validating it.
    renderForm();
    await userEvent.click(screen.getByRole('button', { name: /Game server/ }));
    await screen.findByRole('button', { name: /Java Edition/ });
    expect(screen.queryByLabelText('Environment key 1')).not.toBeInTheDocument();
  });

  // The Placement control let you pin a server to a node and then never sent the
  // choice — the orchestrator always picked the emptiest one, so a deliberate pin
  // was silently overruled (#254).
  it('sends the pinned node when placement is not Auto', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/nodes'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ id: 'node-rack', name: 'rack-1', health: 'healthy', cpuPercent: 10, ramUsedMb: 1000, ramTotalMb: 8000, diskUsedGb: null, diskTotalGb: null, lastHeartbeat: new Date().toISOString() }],
        } as Response);
      if (path.includes('/eggs')) return Promise.resolve({ ok: true, status: 200, json: async () => [MINECRAFT_EGG] } as Response);
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response);
    });
    renderForm();

    await userEvent.type(screen.getByLabelText('Name'), 'pinned');
    await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
    await userEvent.click(await screen.findByRole('button', { name: /rack-1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST');
    expect(JSON.parse(call![1].body as string).nodeId).toBe('node-rack');
  });

  it('sends no node when placement is left on Auto', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText('Name'), 'auto');
    await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST');
    expect(JSON.parse(call![1].body as string)).not.toHaveProperty('nodeId');
  });

  it('no longer offers controls that go nowhere', async () => {
    renderForm();
    // Both were written to state and read by nothing (#255, #256).
    expect(screen.queryByText(/startup command/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/feature limits/i)).not.toBeInTheDocument();
  });

  // The container cap and the heap control the same physical RAM (#271); the form
  // warns while you are setting it, and the API still refuses.
  it('warns when the heap cannot fit the memory limit on the chosen node', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/nodes'))
        return Promise.resolve({
          ok: true,
          status: 200,
          // 4 GB node: the default 50% limit is a 2048 MB cap, and the egg's
          // default heap is 2G — the collision the defaults used to produce.
          json: async () => [{ id: 'n1', name: 'small-box', health: 'healthy', cpuPercent: 10, ramUsedMb: 1000, ramTotalMb: 4096, diskUsedGb: null, diskTotalGb: null, lastHeartbeat: new Date().toISOString() }],
        } as Response);
      if (path.includes('/eggs')) return Promise.resolve({ ok: true, status: 200, json: async () => [MINECRAFT_EGG] } as Response);
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response);
    });
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /Game server/ }));
    await screen.findByRole('button', { name: /Java Edition/ });

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(/2048 MB heap will not fit a 2048 MB limit/);
    // The number people can act on, not the percentage the setting is stored in.
    expect(warning).toHaveTextContent(/Java claims the whole heap up front/);
  });

  it('shows the memory limit in MB for the chosen node', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/nodes'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ id: 'n1', name: 'big-box', health: 'healthy', cpuPercent: 10, ramUsedMb: 1000, ramTotalMb: 32768, diskUsedGb: null, diskTotalGb: null, lastHeartbeat: new Date().toISOString() }],
        } as Response);
      if (path.includes('/eggs')) return Promise.resolve({ ok: true, status: 200, json: async () => [MINECRAFT_EGG] } as Response);
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response);
    });
    renderForm();

    // 50% of 32 GB — meaningless as "50%", actionable as "16384 MB".
    expect(await screen.findByText(/16384 MB on big-box/)).toBeInTheDocument();
  });

  // Setting limits in the unit you are actually thinking in (#275), against
  // capacity that reflects what is committed rather than what is momentarily used.
  describe('resource units and capacity', () => {
    // 8 GB / 8 cores, mostly "used" by page cache, with 2 GB committed elsewhere.
    const NODE_WITH_CAPACITY = {
      id: 'n1',
      name: 'home-box',
      health: 'healthy',
      cpuPercent: 4,
      cpuCores: 8,
      ramUsedMb: 7000,
      ramTotalMb: 8192,
      diskUsedGb: null,
      diskTotalGb: null,
      lastHeartbeat: new Date().toISOString(),
      capacity: {
        ramTotalMb: 8192,
        ramCommittedMb: 2048,
        ramUsedMb: 7000,
        ramAvailableMb: 6144,
        cpuCoresTotal: 8,
        cpuCoresCommitted: 2,
        cpuUsedPercent: 4,
        cpuCoresAvailable: 6,
        overCommitted: false,
      },
    };

    function renderWithCapacity() {
      fetchMock.mockImplementation((url: string) => {
        const path = String(url);
        if (path.includes('/nodes')) return Promise.resolve({ ok: true, status: 200, json: async () => [NODE_WITH_CAPACITY] } as Response);
        if (path.includes('/eggs')) return Promise.resolve({ ok: true, status: 200, json: async () => [MINECRAFT_EGG] } as Response);
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response);
      });
      renderForm();
    }

    it('reports what is uncommitted, not what is unused', async () => {
      renderWithCapacity();
      // 7000 of 8192 MB reads as used, and 6144 MB is genuinely available.
      expect(await screen.findByText(/6144 MB of 8192 MB uncommitted on home-box/)).toBeInTheDocument();
      expect(screen.getByText(/6 of 8 cores uncommitted on home-box/)).toBeInTheDocument();
    });

    it('shows committed against total rather than a bare percentage', async () => {
      renderWithCapacity();
      expect(await screen.findByText('2048 MB committed of 8192 MB')).toBeInTheDocument();
      expect(screen.getByText('2 cores committed of 8 cores')).toBeInTheDocument();
    });

    it('sends an absolute memory limit when MB is chosen', async () => {
      renderWithCapacity();
      await screen.findByText(/MB uncommitted on home-box/);

      await userEvent.type(screen.getByLabelText('Name'), 'svc');
      await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
      await userEvent.click(screen.getByRole('button', { name: 'RAM limit in MB' }));

      const field = screen.getByLabelText('RAM limit');
      await userEvent.clear(field);
      await userEvent.type(field, '6144');
      await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

      expect(await screen.findByText('Servers page')).toBeInTheDocument();
      const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST');
      const limits = JSON.parse(call![1].body as string).resourceLimits;
      expect(limits.ramMb).toBe(6144);
      // Only one unit is sent; sending both would be ambiguous.
      expect(limits.ramPercent).toBeUndefined();
    });

    it('sends an absolute core count when cores is chosen', async () => {
      renderWithCapacity();
      await screen.findByText(/MB uncommitted on home-box/);

      await userEvent.type(screen.getByLabelText('Name'), 'svc');
      await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
      await userEvent.click(screen.getByRole('button', { name: 'CPU limit in cores' }));

      const field = screen.getByLabelText('CPU limit');
      await userEvent.clear(field);
      await userEvent.type(field, '4');
      await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

      expect(await screen.findByText('Servers page')).toBeInTheDocument();
      const call = fetchMock.mock.calls.find(([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST');
      const limits = JSON.parse(call![1].body as string).resourceLimits;
      expect(limits.cpuCores).toBe(4);
      expect(limits.cpuPercent).toBeUndefined();
    });

    it('converts the value when the unit is switched rather than resetting it', async () => {
      renderWithCapacity();
      await screen.findByText(/MB uncommitted on home-box/);

      // The form starts at 50% of an 8192 MB node.
      await userEvent.click(screen.getByRole('button', { name: 'RAM limit in MB' }));
      expect(screen.getByLabelText('RAM limit')).toHaveValue(4096);

      // And back again, unchanged.
      await userEvent.click(screen.getByRole('button', { name: 'RAM limit in %' }));
      expect(screen.getByLabelText('RAM limit percent')).toHaveValue('50');
    });

    it('warns when the request exceeds what the node has left', async () => {
      renderWithCapacity();
      await screen.findByText(/MB uncommitted on home-box/);

      await userEvent.click(screen.getByRole('button', { name: 'RAM limit in MB' }));
      const field = screen.getByLabelText('RAM limit');
      await userEvent.clear(field);
      await userEvent.type(field, '8000'); // more than the 6144 uncommitted

      expect(await screen.findByRole('alert')).toHaveTextContent(/More than this node has left/);
    });
  });

  it('surfaces an API error and stays on the form', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'No healthy node available' }),
    } as Response);
    renderForm();

    await userEvent.type(screen.getByLabelText('Name'), 'svc');
    await userEvent.type(screen.getByLabelText('Docker image'), 'nginx');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No healthy node available');
  });
});
