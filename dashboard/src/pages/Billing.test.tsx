import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from '@testing-library/react';
import { Billing, newlyConfirmed, refreshInterval, POLL_MS, PENDING_POLL_MS } from './Billing';
import type { LedgerEntry } from '../api';
import { ToastProvider } from '../components/Toast';

// Fetch is stubbed per-URL to stand in for the orchestrator billing proxy.
const plan = { id: 'standard', name: 'Standard', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, maxServers: 5, maxDatabases: 5 };

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body } as Response;
}

function routeFetch(url: string) {
  if (url.endsWith('/billing/wallet')) return Promise.resolve(jsonResponse({ userId: 'u1', balance: 12.5, currency: 'EUR' }));
  if (url.endsWith('/billing/usage')) return Promise.resolve(jsonResponse({ hours: 3.5, cost: 0, plan }));
  if (url.endsWith('/billing/ledger')) return Promise.resolve(jsonResponse([]));
  if (url.endsWith('/billing/topup')) return Promise.resolve(jsonResponse({ status: 'pending', reference: 'r1' }, 202));
  if (url.endsWith('/me/entitlements')) {
    return Promise.resolve(
      jsonResponse({
        entitlements: { ...plan, planId: 'standard', planName: 'Standard', maxRamMb: 8192, maxBackupsPerServer: 10, charging: { basis: 'runtime-hours', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, sizeFactor: { standardCpuPercent: 50, standardRamPercent: 50, minimum: 0.25 } } },
        usage: { servers: 0, databases: 0, ramMb: 0, uncappedServers: 0 },
      })
    );
  }
  return Promise.resolve(jsonResponse({}));
}

function renderBilling() {
  return render(
    <ToastProvider>
      <Billing />
    </ToastProvider>
  );
}

describe('Billing page', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn((url: string) => routeFetch(String(url))));
  });
  afterEach(() => vi.unstubAllGlobals());

  // #297: a customer who cannot predict the bill reads "nothing was charged when
  // I created a server" as a bug rather than as the model.
  it('says how the plan charges', async () => {
    renderBilling();
    expect(await screen.findByText(/for each hour a server runs/)).toBeInTheDocument();
    expect(screen.getByText(/first 100 hours each month are free, shared across all your servers/)).toBeInTheDocument();
  });

  it('shows the credit balance and plan', async () => {
    renderBilling();
    // Currency formatting is locale-dependent (e.g. "€12.50" or "€ 12,50"); match the digits.
    expect(await screen.findByText(/12[.,]50/)).toBeInTheDocument();
    expect(await screen.findByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('3.5 runtime hours')).toBeInTheDocument();
  });

  it('posts a top-up to the billing endpoint', async () => {
    renderBilling();
    await screen.findByText(/12[.,]50/);
    await userEvent.click(screen.getByRole('button', { name: /Top up/ }));

    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const topup = calls.find((c: unknown[]) => String(c[0]).endsWith('/billing/topup'));
      expect(topup).toBeTruthy();
      expect(JSON.parse((topup![1] as RequestInit).body as string)).toEqual({ amount: 10 });
    });
  });

  describe('keeping the balance current (#296)', () => {
    const entry = (over: Partial<LedgerEntry>): LedgerEntry =>
      ({ id: 'l1', type: 'topup', amount: 10, currency: 'EUR', status: 'pending', description: 'Top-up', createdAt: new Date().toISOString(), ...over }) as LedgerEntry;

    it('polls faster while a top-up is waiting on FinVault', () => {
      expect(refreshInterval([])).toBe(POLL_MS);
      expect(refreshInterval([entry({ status: 'confirmed' })])).toBe(POLL_MS);
      expect(refreshInterval([entry({ status: 'pending' })])).toBe(PENDING_POLL_MS);
      // A pending *charge* is not something the person is watching for.
      expect(refreshInterval([entry({ type: 'charge', status: 'pending' })])).toBe(POLL_MS);
    });

    it('notices a top-up that went from pending to confirmed', () => {
      const before = [entry({ id: 'a' }), entry({ id: 'b', status: 'confirmed' })];
      const after = [entry({ id: 'a', status: 'confirmed' }), entry({ id: 'b', status: 'confirmed' }), entry({ id: 'c', status: 'confirmed' })];
      expect(newlyConfirmed(before, after).map((e) => e.id)).toEqual(['a']);
      expect(newlyConfirmed(after, after)).toEqual([]);
    });

    it('refreshes on its own, and a confirmed top-up moves the balance without a reload', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let balance = 12.5;
        let ledger: LedgerEntry[] = [entry({ id: 't1' })];
        vi.stubGlobal(
          'fetch',
          vi.fn((url: string) => {
            if (url.endsWith('/billing/wallet')) return Promise.resolve(jsonResponse({ userId: 'u1', balance, currency: 'EUR' }));
            if (url.endsWith('/billing/ledger')) return Promise.resolve(jsonResponse(ledger));
            return routeFetch(url);
          })
        );
        renderBilling();
        expect(await screen.findByText(/12[.,]50/)).toBeInTheDocument();

        // FinVault confirms while the person is looking at the page.
        balance = 22.5;
        ledger = [entry({ id: 't1', status: 'confirmed' })];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PENDING_POLL_MS + 50);
        });

        expect(await screen.findByText(/22[.,]50/)).toBeInTheDocument();
        expect(await screen.findByText(/credit has been added/i)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says when the figures were read', async () => {
      renderBilling();
      await screen.findByText(/12[.,]50/);
      expect(screen.getByText(/Updated/)).toBeInTheDocument();
    });

    it('keeps the last figures but says plainly when a refresh fails', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let failing = false;
        vi.stubGlobal(
          'fetch',
          vi.fn((url: string) => (failing ? Promise.resolve(jsonResponse({ error: 'bridge down' }, 502)) : routeFetch(url)))
        );
        renderBilling();
        await screen.findByText(/12[.,]50/);

        failing = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(POLL_MS + 50);
        });

        // The balance stays on screen — it is the last known value — but it is
        // no longer presented as current.
        expect(screen.getByText(/12[.,]50/)).toBeInTheDocument();
        expect(await screen.findByText(/Could not refresh/)).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
