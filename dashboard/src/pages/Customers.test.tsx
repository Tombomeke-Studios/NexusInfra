import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Customers } from './Customers';
import { PlanChooser } from '../components/PlanChooser';
import { ToastProvider } from '../components/Toast';
import { DialogProvider } from '../components/Dialog';

const STANDARD = { id: 'standard', name: 'Standard', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, maxServers: 5, maxDatabases: 5, maxRamMb: 8192, maxBackupsPerServer: 10, active: true };
const PRO = { ...STANDARD, id: 'pro', name: 'Pro', pricePerHour: 0.05, freeHoursPerMonth: 0, maxServers: 20, maxRamMb: 32768 };
const LEGACY = { ...STANDARD, id: 'legacy', name: 'Legacy', active: false };

const ACCOUNTS = [
  { userId: 'u1', email: 'ada@example.com', displayName: 'Ada', platformRole: 'user', createdAt: '2026-09-01T00:00:00.000Z', servers: 3, runningServers: 2, planId: 'pro', planName: 'Pro', balance: 40, available: 31.5, canRun: true, currency: 'EUR', hours: 170, cost: 8.5 },
  { userId: 'u2', email: 'bob@example.com', displayName: 'Bob', platformRole: 'user', createdAt: '2026-09-02T00:00:00.000Z', servers: 1, runningServers: 0, planId: 'standard', planName: 'Standard', balance: 0, available: -2, canRun: false, currency: 'EUR', hours: 12, cost: 2 },
];

const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

function stubApi(overrides: (call: Call) => Response | undefined = () => undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const override = overrides(call);
      if (override) return override;
      if (call.url.endsWith('/billing/admin/accounts')) return json(ACCOUNTS);
      if (call.url.endsWith('/billing/admin/plans') && call.method === 'GET') return json([STANDARD, PRO, LEGACY]);
      if (call.url.endsWith('/billing/plans')) return json({ currentPlanId: 'standard', plans: [{ ...STANDARD, problem: null }, { ...PRO, problem: null }] });
      return json({});
    })
  );
}

const wrap = (ui: React.ReactElement) =>
  render(
    <ToastProvider>
      <DialogProvider>{ui}</DialogProvider>
    </ToastProvider>
  );

const sent = (suffix: string, method: string) => calls.filter((c) => c.url.endsWith(suffix) && c.method === method);

describe('Customers page (#369)', () => {
  beforeEach(() => {
    localStorage.clear();
    stubApi();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists every account with its plan, usage and what is left', async () => {
    wrap(<Customers />);
    const row = (await screen.findByText('ada@example.com')).closest('tr')!;
    expect(within(row).getByText(/2 running/)).toBeInTheDocument();
    expect(within(row).getByText(/31[.,]50/)).toBeInTheDocument();
    expect(within(row).getByRole('combobox', { name: 'Plan for ada@example.com' })).toHaveValue('pro');
    // An account that has run out says so.
    expect(within(screen.getByText('bob@example.com').closest('tr')!).getByText('Cannot run')).toBeInTheDocument();
  });

  it('adds up the business at the top', async () => {
    wrap(<Customers />);
    expect(await screen.findByText('Servers running now')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Credit held').parentElement).toHaveTextContent(/40[.,]00/));
    // The same words head a column further down; the figure comes first.
    expect(screen.getAllByText('Used this month')[0].parentElement).toHaveTextContent(/10[.,]50/);
  });

  it('adjusts an account’s credit with a reason', async () => {
    wrap(<Customers />);
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust credit for bob@example.com' }));
    await userEvent.type(screen.getByLabelText('Amount (EUR)'), '10');
    // No reason: refused here, nothing sent.
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/Say why/)).toBeInTheDocument();
    expect(sent('/billing/admin/accounts/u2/credit', 'POST')).toEqual([]);

    await userEvent.type(screen.getByLabelText(/Reason/), 'goodwill');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sent('/billing/admin/accounts/u2/credit', 'POST')).toHaveLength(1));
    expect(sent('/billing/admin/accounts/u2/credit', 'POST')[0].body).toEqual({ amount: 10, reason: 'goodwill' });
  });

  it('moves an account to another plan on offer', async () => {
    wrap(<Customers />);
    const select = await screen.findByRole('combobox', { name: 'Plan for bob@example.com' });
    // A retired plan is not offered to an account that is not on it.
    expect(within(select).queryByRole('option', { name: /Legacy/ })).toBeNull();
    await userEvent.selectOptions(select, 'pro');
    await waitFor(() => expect(sent('/billing/admin/accounts/u2/plan', 'PUT')[0]?.body).toEqual({ planId: 'pro' }));
  });

  it('adds a plan, entering memory in GB', async () => {
    wrap(<Customers />);
    await userEvent.click(await screen.findByRole('button', { name: 'New plan' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Mega');
    await userEvent.type(screen.getByLabelText(/Price per server-hour/), '0.1');
    await userEvent.type(screen.getByLabelText(/Memory across all servers/), '64');
    await userEvent.click(screen.getByRole('button', { name: 'Add plan' }));
    await waitFor(() => expect(sent('/billing/admin/plans', 'POST')).toHaveLength(1));
    expect(sent('/billing/admin/plans', 'POST')[0].body).toMatchObject({ name: 'Mega', pricePerHour: 0.1, maxRamMb: 65536, maxBackupsPerServer: null });
  });

  it('retires a plan and offers a retired one again', async () => {
    wrap(<Customers />);
    await userEvent.click(await screen.findByRole('button', { name: 'Retire the Pro plan' }));
    await waitFor(() => expect(sent('/billing/admin/plans/pro', 'PUT')[0]?.body).toEqual({ active: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Offer the Legacy plan again' }));
    await waitFor(() => expect(sent('/billing/admin/plans/legacy', 'PUT')[0]?.body).toEqual({ active: true }));
  });

  it('tells a non-administrator why the page is empty', async () => {
    stubApi((call) => (call.url.includes('/billing/admin/') ? json({ error: 'platform administrator role required' }, 403) : undefined));
    wrap(<Customers />);
    expect(await screen.findByText(/Only platform administrators/)).toBeInTheDocument();
  });
});

describe('the plan chooser on the Billing page (#369)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('marks the plan you are on and switches after you confirm', async () => {
    stubApi();
    const onChanged = vi.fn();
    wrap(<PlanChooser onChanged={onChanged} />);
    expect(await screen.findByText('Your plan')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Pro' }));
    // Nothing is sent until the consequence has been read and accepted.
    expect(sent('/billing/plan', 'PUT')).toEqual([]);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch to Pro' }));
    await waitFor(() => expect(sent('/billing/plan', 'PUT')[0]?.body).toEqual({ planId: 'pro' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('explains a plan the account does not fit instead of offering it', async () => {
    stubApi((call) =>
      call.url.endsWith('/billing/plans') ? json({ currentPlanId: 'pro', plans: [{ ...STANDARD, problem: 'you have 8 servers and the Standard plan allows 5 — delete 3 servers first' }, { ...PRO, problem: null }] }) : undefined
    );
    wrap(<PlanChooser />);
    expect(await screen.findByText(/delete 3 servers first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to Standard' })).toBeNull();
  });

  it('shows nothing when there is only one plan — that is not a choice', async () => {
    stubApi((call) => (call.url.endsWith('/billing/plans') ? json({ currentPlanId: 'standard', plans: [{ ...STANDARD, problem: null }] }) : undefined));
    const { container } = wrap(<PlanChooser />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/billing/plans'))).toBe(true));
    expect(container.querySelector('section')).toBeNull();
  });
});
