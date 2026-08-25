import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeploymentDrawer } from './DeploymentDrawer';

const detail = {
  id: 'd1',
  name: 'my-nginx',
  dockerImage: 'nginx',
  nodeId: 'node-local',
  containerId: 'abcdef123456',
  status: 'running',
  startedAt: '2026-07-22T00:00:00.000Z',
  stoppedAt: null,
  createdAt: '2026-07-22T00:00:00.000Z',
  events: [
    { id: 'e1', event: 'created', message: 'placed on node node-local', timestamp: '2026-07-22T00:00:00.000Z' },
    { id: 'e2', event: 'started', message: 'container abcdef123456 started', timestamp: '2026-07-22T00:00:01.000Z' },
  ],
};

describe('DeploymentDrawer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => detail } as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the deployment metadata and event trail', async () => {
    render(<DeploymentDrawer deploymentId="d1" onClose={() => {}} />);

    expect(await screen.findByText('Event trail')).toBeInTheDocument();
    expect(screen.getByText('created')).toBeInTheDocument();
    expect(screen.getByText('started')).toBeInTheDocument();
    expect(screen.getByText('abcdef123456')).toBeInTheDocument();
  });
});
