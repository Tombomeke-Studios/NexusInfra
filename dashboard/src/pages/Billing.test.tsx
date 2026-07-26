import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Billing } from './Billing';
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
});
