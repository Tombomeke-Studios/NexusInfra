import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPanel } from './PlanPanel';

// #297: the plan's boundaries beside the size being chosen.

const entitlements = (over: Record<string, unknown> = {}) => ({
  planId: 'standard',
  planName: 'Standard',
  maxServers: 5,
  maxDatabases: 5,
  maxRamMb: 4096,
  maxBackupsPerServer: 10,
  charging: { basis: 'runtime-hours', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, sizeFactor: { standardCpuPercent: 50, standardRamPercent: 50, minimum: 0.25 } },
  ...over,
});

function answer(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 300, status, statusText: '', json: async () => body }) as Response));
}

afterEach(() => vi.unstubAllGlobals());

describe('PlanPanel', () => {
  it('shows the ceilings, what is spent, and how it is charged', async () => {
    answer({ entitlements: entitlements(), usage: { servers: 2, databases: 1, ramMb: 1024, uncappedServers: 0 } });
    render(<PlanPanel requestedRamMb={2048} />);

    expect(await screen.findByText('Your plan · Standard')).toBeInTheDocument();
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
    expect(screen.getByText('1 GB of 4 GB')).toBeInTheDocument();
    expect(screen.getByText('1 of 5')).toBeInTheDocument();
    expect(screen.getByText('newest 10 kept')).toBeInTheDocument();
    expect(screen.getByText('With this server: 3 GB of 4 GB committed.')).toBeInTheDocument();
    expect(screen.getByText(/for each hour a server runs/)).toBeInTheDocument();
    expect(screen.getByText(/Creating a server costs nothing, and neither does a stopped one/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns before Create when the size does not fit what is left', async () => {
    answer({ entitlements: entitlements(), usage: { servers: 2, databases: 0, ramMb: 3072, uncappedServers: 0 } });
    render(<PlanPanel requestedRamMb={2048} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This server needs 2 GB of memory, and your plan has 1 GB of its 4 GB left.');
  });

  it('offers the memory that is left, rather than only refusing', async () => {
    answer({ entitlements: entitlements(), usage: { servers: 2, databases: 0, ramMb: 3072, uncappedServers: 0 } });
    const use = vi.fn();
    render(<PlanPanel requestedRamMb={8192} onUseRamMb={use} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use the 1 GB left' }));
    expect(use).toHaveBeenCalledWith(1024);
  });

  it('offers nothing when nothing is left', async () => {
    answer({ entitlements: entitlements(), usage: { servers: 2, databases: 0, ramMb: 4096, uncappedServers: 0 } });
    render(<PlanPanel requestedRamMb={1024} onUseRamMb={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('warns that a server needs a memory limit under a ceiling', async () => {
    answer({ entitlements: entitlements(), usage: { servers: 0, databases: 0, ramMb: 0, uncappedServers: 0 } });
    render(<PlanPanel requestedRamMb={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a memory limit');
  });

  it('says so when every server the plan allows is in use', async () => {
    answer({ entitlements: entitlements({ maxServers: 2 }), usage: { servers: 2, databases: 0, ramMb: 0, uncappedServers: 0 } });
    render(<PlanPanel requestedRamMb={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Your plan's 2 servers are all in use.");
  });

  it('renders nothing where no plan applies', async () => {
    answer({ error: 'no plan applies to this account' }, 404);
    const { container } = render(<PlanPanel requestedRamMb={2048} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('describes a plan without ceilings as such', async () => {
    answer({ entitlements: entitlements({ maxRamMb: null, maxServers: null, maxBackupsPerServer: null }), usage: { servers: 3, databases: 0, ramMb: 2048, uncappedServers: 0 } });
    render(<PlanPanel requestedRamMb={2048} />);
    expect(await screen.findByText('no limit')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2 GB')).toBeInTheDocument();
  });
});
