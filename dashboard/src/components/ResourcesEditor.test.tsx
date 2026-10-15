import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResourcesEditor } from './ResourcesEditor';
import { ToastProvider } from './Toast';
import type { DeploymentDetail } from '../api';

// Resizing a server after creation (#381). Memory is the one number set: the
// Java heap is shown following it, and never sent.

const MINECRAFT_EGG = { id: 'minecraft-java', name: 'Minecraft', description: '', variables: [], memoryVariable: 'MEMORY' };
const NODE = { id: 'node-1', name: 'box', ramTotalMb: 16384, cpuCores: 8, health: 'healthy', lastHeartbeat: '', cpuPercent: 0, ramUsedMb: 0, diskUsedGb: null, diskTotalGb: null };

const SERVER = {
  id: 'dep-1',
  name: 'survival',
  dockerImage: 'itzg/minecraft-server',
  type: 'minecraft-java',
  nodeId: 'node-1',
  containerId: null,
  status: 'stopped',
  createdAt: '',
  events: [],
  ports: {},
  env: { MEMORY: '1536M', EULA: 'TRUE' },
  resourceLimits: { ramMb: 2048, cpuCores: 2, swapPercent: 0, ioPriority: 'normal', restartPolicy: 'on-failure', oomKill: true },
  autoRestart: true,
} as unknown as DeploymentDetail;

function setup(deployment: DeploymentDetail = SERVER) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const body = path.includes('/eggs') ? [MINECRAFT_EGG] : path.includes('/nodes') ? [NODE] : init?.method === 'PATCH' ? deployment : [];
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onSaved = vi.fn();
  render(
    <ToastProvider>
      <ResourcesEditor deployment={deployment} onSaved={onSaved} />
    </ToastProvider>
  );
  return { fetchMock, onSaved };
}

describe('ResourcesEditor', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens on the size the server has now', async () => {
    setup();
    expect(screen.getByLabelText('RAM limit')).toHaveValue(2048);
    expect(screen.getByLabelText('CPU limit')).toHaveValue(2);
    await waitFor(() => expect(screen.getByTestId('heap-preview')).toHaveTextContent('1536 MB'));
  });

  it('shows the heap following the memory limit as it changes', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('heap-preview')).toBeInTheDocument());
    const ram = screen.getByLabelText('RAM limit');
    await userEvent.clear(ram);
    await userEvent.type(ram, '4096');
    expect(screen.getByTestId('heap-preview')).toHaveTextContent('3276 MB');
    expect(screen.getByTestId('heap-preview')).toHaveTextContent('now 1536M');
  });

  it('saves the new limits without a heap, keeping the policies it does not edit', async () => {
    const { fetchMock, onSaved } = setup();
    await waitFor(() => expect(screen.getByTestId('heap-preview')).toBeInTheDocument());
    const ram = screen.getByLabelText('RAM limit');
    await userEvent.clear(ram);
    await userEvent.type(ram, '6144');
    await userEvent.click(screen.getByRole('button', { name: 'Save resources' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    const body = JSON.parse(String((patch![1] as RequestInit).body));
    expect(body).toEqual({
      resourceLimits: { ramMb: 6144, cpuCores: 2, swapPercent: 0, ioPriority: 'normal', restartPolicy: 'on-failure', oomKill: true },
    });
    expect(body).not.toHaveProperty('eggValues');
    expect(body).not.toHaveProperty('env');
  });

  it('refuses a limit no Java server fits in before it is sent', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('heap-preview')).toBeInTheDocument());
    const ram = screen.getByLabelText('RAM limit');
    await userEvent.clear(ram);
    await userEvent.type(ram, '768');
    expect(screen.getByRole('alert')).toHaveTextContent('too small to run a Java server');
    expect(screen.getByRole('button', { name: 'Save resources' })).toBeDisabled();
  });

  it('shows no heap at all for a server without one', async () => {
    setup({ ...SERVER, type: 'app', env: {} } as unknown as DeploymentDetail);
    await waitFor(() => expect(screen.getByLabelText('RAM limit')).toBeInTheDocument());
    expect(screen.queryByTestId('heap-preview')).toBeNull();
  });
});
