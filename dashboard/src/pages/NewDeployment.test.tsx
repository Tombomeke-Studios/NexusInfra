import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { NewDeployment } from './NewDeployment';

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
    fetchMock.mockImplementation((url: string) =>
      typeof url === 'string' && url.includes('/nodes')
        ? Promise.resolve({ ok: true, status: 200, json: async () => [] } as Response)
        : Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response)
    );
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

  it('deploys a game server with a real image and startup env', async () => {
    renderForm();

    await userEvent.click(screen.getByRole('button', { name: /Game server/ }));
    await userEvent.type(screen.getByLabelText('Name'), 'mc');
    await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(await screen.findByText('Servers page')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.includes('/deployments') && o?.method === 'POST'
    );
    const body = JSON.parse(call![1].body as string);
    expect(body.dockerImage).toBe('itzg/minecraft-server');
    expect(body.type).toBe('game');
    expect(body.ports).toEqual({ '25565': '25565' });
    expect(body.env).toMatchObject({ EULA: 'TRUE', TYPE: 'PAPER' });
  });

  // The Placement control let you pin a server to a node and then never sent the
  // choice — the orchestrator always picked the emptiest one, so a deliberate pin
  // was silently overruled (#254).
  it('sends the pinned node when placement is not Auto', async () => {
    fetchMock.mockImplementation((url: string) =>
      typeof url === 'string' && url.includes('/nodes')
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [{ id: 'node-rack', name: 'rack-1', health: 'healthy', cpuPercent: 10, ramUsedMb: 1000, ramTotalMb: 8000, diskUsedGb: null, diskTotalGb: null, lastHeartbeat: new Date().toISOString() }],
          } as Response)
        : Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'd1' }) } as Response)
    );
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
