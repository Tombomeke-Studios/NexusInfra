import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Servers } from './Servers';

const renderServers = () => render(<Servers />, { wrapper: MemoryRouter });

const ME = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', platformRole: 'user', createdAt: '' };

const deployments = [
  { id: 'd1', name: 'my-nginx', dockerImage: 'nginx', nodeId: 'node-local', containerId: 'abcdef123456', status: 'running', startedAt: '', stoppedAt: null, createdAt: '' },
  { id: 'd2', name: 'idle', dockerImage: 'redis', nodeId: 'node-local', containerId: null, status: 'stopped', startedAt: null, stoppedAt: '', createdAt: '' },
];

describe('Servers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && (url.endsWith('/stop') || url.endsWith('/restart') || url.endsWith('/start'))) {
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ status: 'ok' }) } as Response);
      }
      // The list answers a page envelope now (#237); /me answers the account.
      if (typeof url === 'string' && url.includes('/me')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ME } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: deployments, total: deployments.length, limit: 25, offset: 0 }),
      } as Response);
      void options;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows each server its own limits and kind rather than a fixed line (#318)', async () => {
    const own = [
      { ...deployments[0], type: 'valheim', resourceLimits: { cpuPercent: 40, ramMb: 4096 } },
      { ...deployments[1], type: 'app', resourceLimits: {} },
    ];
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (url.includes('/me') ? ME : { items: own, total: own.length, limit: 25, offset: 0 }),
      } as Response)
    );
    renderServers();
    await screen.findByText('my-nginx');

    expect(screen.getByText('cpu 40% · ram 4096 MB')).toBeInTheDocument();
    expect(screen.queryByText('cpu 50% · ram 50%')).not.toBeInTheDocument();
    expect(screen.getByText('game')).toBeInTheDocument();
    expect(screen.getByText('app')).toBeInTheDocument();
  });

  it('lists deployments with status and container id', async () => {
    renderServers();
    expect(await screen.findByText('my-nginx')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('abcdef123456')).toBeInTheDocument();
  });

  it('shows Stop only for running deployments and calls the stop endpoint', async () => {
    renderServers();
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
    renderServers();
    await screen.findByText('my-nginx');

    await userEvent.click(screen.getByRole('button', { name: 'Restart my-nginx' }));

    const restartCall = fetchMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.includes('/deployments/d1/restart') && o?.method === 'POST'
    );
    expect(restartCall).toBeDefined();
  });

  it('shows Start for a stopped deployment and calls the start endpoint', async () => {
    renderServers();
    await screen.findByText('idle');

    await userEvent.click(screen.getByRole('button', { name: 'Start idle' }));

    const startCall = fetchMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.includes('/deployments/d2/start') && o?.method === 'POST'
    );
    expect(startCall).toBeDefined();
  });
  describe('bulk actions (#238)', () => {
    const bulkReply = (body: unknown) =>
      fetchMock.mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes('/deployments/bulk')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
        }
        if (url.includes('/me')) return Promise.resolve({ ok: true, status: 200, json: async () => ME } as Response);
        void options;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ items: deployments, total: deployments.length, limit: 25, offset: 0 }),
        } as Response);
      });

    it('offers bulk controls only once something is selected', async () => {
      renderServers();
      await screen.findByText('my-nginx');
      expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select my-nginx' }));
      expect(screen.getByRole('toolbar', { name: 'Bulk actions' })).toHaveTextContent('1 selected');
    });

    it('sends every selected id in one request', async () => {
      bulkReply({ action: 'stop', succeeded: 2, failed: 0, results: [{ id: 'd1', ok: true, status: 202 }, { id: 'd2', ok: true, status: 202 }] });
      renderServers();
      await screen.findByText('my-nginx');

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all my servers' }));
      expect(screen.getByRole('toolbar', { name: 'Bulk actions' })).toHaveTextContent('2 selected');
      await userEvent.click(screen.getByRole('button', { name: /Stop selected/ }));

      const call = fetchMock.mock.calls.find(([u]) => typeof u === 'string' && u.includes('/deployments/bulk'));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ action: 'stop', ids: ['d1', 'd2'] });
      // Everything worked, so the selection is spent.
      await vi.waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).not.toBeInTheDocument());
    });

    it('names each server that failed, with the reason, and keeps it selected for a retry', async () => {
      bulkReply({
        action: 'stop',
        succeeded: 1,
        failed: 1,
        results: [
          { id: 'd1', name: 'my-nginx', ok: true, status: 202 },
          { id: 'd2', name: 'idle', ok: false, status: 409, error: 'deployment is not running' },
        ],
      });
      renderServers();
      await screen.findByText('my-nginx');

      await userEvent.click(screen.getByRole('checkbox', { name: 'Select all my servers' }));
      await userEvent.click(screen.getByRole('button', { name: /Stop selected/ }));

      const report = await screen.findByText(/could not be changed/);
      expect(report.closest('[role="alert"]')).toHaveTextContent('idle — deployment is not running');
      expect(screen.getByRole('toolbar', { name: 'Bulk actions' })).toHaveTextContent('1 selected');
      expect(screen.getByRole('checkbox', { name: 'Select idle' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Select my-nginx' })).not.toBeChecked();
    });
  });
});

// ── Search, filter and paging (#237) ─────────────────────────────────────────

describe('Servers list at scale', () => {
  const fetchMock = vi.fn();

  /** 60 servers, so there is genuinely more than one page. */
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `d${i}`,
    name: i % 2 === 0 ? `web-${i}` : `db-${i}`,
    dockerImage: 'nginx',
    nodeId: 'node-local',
    containerId: `c${i}`,
    status: i % 3 === 0 ? 'stopped' : 'running',
    startedAt: '',
    stoppedAt: null,
    createdAt: '',
  }));

  /** Answers as the API does: filter, then cut the page, then report the total. */
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/me')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ME } as Response);
      }
      const query = new URLSearchParams(path.split('?')[1] ?? '');
      const q = query.get('q')?.toLowerCase() ?? '';
      const status = query.get('status') ?? '';
      const limit = Number(query.get('limit') ?? 25);
      const offset = Number(query.get('offset') ?? 0);
      const matched = many.filter((d) => (!q || d.name.includes(q)) && (!status || d.status === status));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: matched.slice(offset, offset + limit), total: matched.length, limit, offset }),
      } as Response);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const lastQuery = () => new URLSearchParams(String(fetchMock.mock.calls.at(-1)?.[0]).split('?')[1] ?? '');

  it('renders one page, and says how many there are in total', async () => {
    render(<Servers />, { wrapper: MemoryRouter });
    expect(await screen.findByText('web-0')).toBeInTheDocument();
    expect(screen.getByText('60 servers')).toBeInTheDocument();
    // Not all sixty: the point is that the browser is not asked to render them.
    expect(screen.queryByText('web-30')).not.toBeInTheDocument();
  });

  it('sends the search to the server rather than filtering what it already has', async () => {
    render(<Servers />, { wrapper: MemoryRouter });
    await screen.findByText('web-0');

    await userEvent.type(screen.getByRole('searchbox', { name: /search servers by name/i }), 'db');
    await screen.findByText(/matching/);

    expect(lastQuery().get('q')).toBe('db');
  });

  it('filters by status', async () => {
    render(<Servers />, { wrapper: MemoryRouter });
    await screen.findByText('web-0');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /filter by status/i }), 'stopped');
    await screen.findByText(/matching/);

    expect(lastQuery().get('status')).toBe('stopped');
  });

  it('pages, and returns to the first page when the filter changes', async () => {
    // Staying on page four of a new filter shows an empty list, which reads as a
    // failure rather than as paging.
    render(<Servers />, { wrapper: MemoryRouter });
    await screen.findByText('web-0');

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    expect(lastQuery().get('offset')).toBe('25');

    await userEvent.type(screen.getByRole('searchbox', { name: /search servers by name/i }), 'web');
    await screen.findByText(/matching/);
    expect(lastQuery().get('offset')).toBeNull();
  });

  it('says nothing matched rather than claiming there are no servers', async () => {
    render(<Servers />, { wrapper: MemoryRouter });
    await screen.findByText('web-0');

    await userEvent.type(screen.getByRole('searchbox', { name: /search servers by name/i }), 'zzz');

    expect(await screen.findByText(/no servers match that search/i)).toBeInTheDocument();
    expect(screen.queryByText(/no deployments yet/i)).not.toBeInTheDocument();
  });
});
