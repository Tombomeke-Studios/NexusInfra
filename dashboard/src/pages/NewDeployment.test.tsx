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
  variables: [
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
