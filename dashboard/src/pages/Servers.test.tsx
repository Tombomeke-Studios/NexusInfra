import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Servers } from './Servers';

const deployments = [
  { id: 'd1', name: 'my-nginx', dockerImage: 'nginx', nodeId: 'node-local', containerId: 'abcdef123456', status: 'running', startedAt: '', stoppedAt: null, createdAt: '' },
  { id: 'd2', name: 'idle', dockerImage: 'redis', nodeId: 'node-local', containerId: null, status: 'pending', startedAt: null, stoppedAt: null, createdAt: '' },
];

describe('Servers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && (url.endsWith('/stop') || url.endsWith('/restart'))) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ status: 'ok' }) } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => deployments } as Response);
      void options;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists deployments with status and container id', async () => {
    render(<Servers />);
    expect(await screen.findByText('my-nginx')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('abcdef123456')).toBeInTheDocument();
  });

  it('shows Stop only for running deployments and calls the stop endpoint', async () => {
    render(<Servers />);
    await screen.findByText('my-nginx');

    // Only the running deployment (d1) has a Stop button.
    const stopButtons = screen.getAllByRole('button', { name: /^Stop/ });
    expect(stopButtons).toHaveLength(1);

    await userEvent.click(stopButtons[0]);

    const stopCall = fetchMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.includes('/deployments/d1/stop') && o?.method === 'POST'
    );
    expect(stopCall).toBeDefined();
  });

  it('restarts a running deployment via the restart endpoint', async () => {
    render(<Servers />);
    await screen.findByText('my-nginx');

    await userEvent.click(screen.getByRole('button', { name: 'Restart my-nginx' }));

    const restartCall = fetchMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.includes('/deployments/d1/restart') && o?.method === 'POST'
    );
    expect(restartCall).toBeDefined();
  });
});
