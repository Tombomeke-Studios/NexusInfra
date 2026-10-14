import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrictMode } from 'react';
import { VerifyEmail } from './VerifyEmail';
import { Billing } from './Billing';
import { EditionProvider } from '../edition';
import { ToastProvider } from '../components/Toast';
import { DialogProvider } from '../components/Dialog';

const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

describe('the confirmation link (#367)', () => {
  let confirms: unknown[];
  beforeEach(() => {
    localStorage.clear();
    confirms = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = (search: string, answer: () => Response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/auth/verify-email/confirm')) {
          confirms.push(JSON.parse(init!.body as string));
          return answer();
        }
        return json({});
      })
    );
    // StrictMode runs effects twice in development; the link must still be spent once.
    return render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/verify-email${search}`]}>
          <VerifyEmail />
        </MemoryRouter>
      </StrictMode>
    );
  };

  it('spends the token once and says the address is confirmed', async () => {
    open('?token=abc123', () => json({ status: 'verified' }));
    expect(await screen.findByText(/Your email address is confirmed/)).toBeInTheDocument();
    expect(confirms).toEqual([{ token: 'abc123' }]);
    // Not signed in on this device: the way on is to sign in.
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('says what to do when the link no longer works', async () => {
    open('?token=old', () => json({ error: 'this confirmation link is invalid, has expired, or has already been used' }, 400));
    expect(await screen.findByRole('alert')).toHaveTextContent(/has already been used\. Links work once and for 24 hours; ask for a new one on the Billing page/);
  });

  it('does not call the server without a token', async () => {
    open('', () => json({}));
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs the link from the confirmation email/);
    expect(confirms).toEqual([]);
  });
});

describe('topping up with an unconfirmed address (#367)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function serve(options: { emailVerification: boolean; emailVerified: boolean }) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push(`${init?.method ?? 'GET'} ${u.replace(/^.*\/api/, '')}`);
        if (u.endsWith('/config')) return json({ edition: 'hosted', emailVerification: options.emailVerification });
        if (u.endsWith('/me')) return json({ id: 'u1', email: 'ada@example.com', displayName: 'Ada', platformRole: 'user', createdAt: '', emailVerified: options.emailVerified });
        if (u.endsWith('/me/verify-email')) return json({ status: 'sent', email: 'ada@example.com' }, 202);
        if (u.endsWith('/billing/wallet')) return json({ userId: 'u1', balance: 0, currency: 'EUR' });
        if (u.endsWith('/billing/ledger')) return json([]);
        if (u.endsWith('/billing/usage')) return json({ hours: 0, cost: 0, plan: { id: 'standard', name: 'Standard', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 0, maxServers: 5, maxDatabases: 5 } });
        return json({});
      })
    );
    render(
      <EditionProvider>
        <ToastProvider>
          <DialogProvider>
            <Billing />
          </DialogProvider>
        </ToastProvider>
      </EditionProvider>
    );
    return calls;
  }

  it('asks for the confirmation first, holds the button, and can send the link again', async () => {
    const calls = serve({ emailVerification: true, emailVerified: false });
    expect(await screen.findByText(/Confirm your email address first/)).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Top up/ })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'send it again' }));
    expect(await screen.findByText(/a new one is on its way/)).toBeInTheDocument();
    expect(calls).toContain('POST /me/verify-email');
  });

  it('says nothing to a confirmed account', async () => {
    serve({ emailVerification: true, emailVerified: true });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Top up/ })).toBeEnabled());
    expect(screen.queryByText(/Confirm your email address first/)).toBeNull();
  });

  // No mail configured: the server gates nothing, so the page must not either.
  it('says nothing where the installation cannot confirm addresses', async () => {
    serve({ emailVerification: false, emailVerified: false });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Top up/ })).toBeEnabled());
    expect(screen.queryByText(/Confirm your email address first/)).toBeNull();
  });
});
