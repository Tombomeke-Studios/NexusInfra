import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Account } from './Account';
import { ToastProvider } from '../components/Toast';

// `GET /me` and `POST /me/password` shipped with accounts (#174) and no page ever
// called them, so changing your own password meant curl (#221).

const ME = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', platformRole: 'user', createdAt: new Date().toISOString() };

const SESSIONS = [
  { id: 's1', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), userAgent: 'This browser', ipAddress: '10.0.0.1', current: true },
  { id: 's2', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), userAgent: 'Firefox on the laptop', ipAddress: '10.0.0.9', current: false },
];

function renderAccount() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <Account />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Account', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          const path = String(url);
          if (path.includes('/me/tokens')) return [];
          return path.includes('/me/sessions') ? SESSIONS : ME;
        },
      } as Response)
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the signed-in account', async () => {
    renderAccount();
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('posts a password change with the current password', async () => {
    renderAccount();
    await screen.findByText('ada@example.com');

    await userEvent.type(screen.getByLabelText('Current password'), 'old-password');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-password');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    const call = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/me/password') && o?.method === 'POST');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ currentPassword: 'old-password', newPassword: 'new-password' });
  });

  it('refuses a mismatched confirmation without calling the API', async () => {
    renderAccount();
    await screen.findByText('ada@example.com');

    await userEvent.type(screen.getByLabelText('Current password'), 'old-password');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'different-one');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/me/password'))).toBe(false);
  });

  it('says plainly that the current password was wrong', async () => {
    renderAccount();
    await screen.findByText('ada@example.com');
    // The API answers 401; "Unauthorized" would tell the user nothing useful.
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/me/sessions')
        ? Promise.resolve({ ok: true, status: 200, json: async () => SESSIONS } as Response)
        : Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) } as Response)
    );

    await userEvent.type(screen.getByLabelText('Current password'), 'wrong-password');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-password');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not your current password/i);
  });
});

// A token used to stay valid until it expired whatever happened to the account,
// so "sign out" was a client-side gesture and nothing could answer "is anyone
// else signed in as me" (#227).
describe('Account sessions', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, status: 200, json: async () => (String(url).includes('/me/sessions') ? SESSIONS : ME) } as Response)
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists where the account is signed in, marking this device', async () => {
    renderAccount();
    expect(await screen.findByText('Firefox on the laptop')).toBeInTheDocument();
    expect(screen.getByText('this device')).toBeInTheDocument();
  });

  it('offers no sign-out for the session making the request', async () => {
    renderAccount();
    await screen.findByText('Firefox on the laptop');
    // One button for the other session, and none for this one.
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });

  it('ends one session by id', async () => {
    renderAccount();
    await screen.findByText('Firefox on the laptop');

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    const call = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/me/sessions/s2') && o?.method === 'DELETE');
    expect(call).toBeDefined();
  });

  it('ends every other session at once', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAccount();
    await screen.findByText('Firefox on the laptop');

    await userEvent.click(screen.getByRole('button', { name: /Sign out everywhere else/ }));

    const call = fetchMock.mock.calls.find(
      ([u, o]) => String(u).endsWith('/me/sessions') && o?.method === 'DELETE'
    );
    expect(call).toBeDefined();
  });
});

// ── API tokens (#228) ────────────────────────────────────────────────────────

describe('Account API tokens', () => {
  const fetchMock = vi.fn();

  const TOKENS = [
    { id: 't1', name: 'deploy pipeline', scopes: ['write'], createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      const path = String(url);
      const body = path.includes('/me/tokens')
        ? opts?.method === 'POST'
          ? { id: 't2', name: 'ci', scopes: ['write'], createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null, secret: 'nxi_the-only-time' }
          : TOKENS
        : path.includes('/me/sessions')
          ? SESSIONS
          : ME;
      return Promise.resolve({ ok: true, status: opts?.method === 'POST' ? 201 : 200, json: async () => body } as Response);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the account’s tokens with what they may do', async () => {
    renderAccount();
    expect(await screen.findByText('deploy pipeline')).toBeInTheDocument();
    expect(screen.getByText(/read and write/i)).toBeInTheDocument();
    expect(screen.getByText(/never used/i)).toBeInTheDocument();
  });

  it('creates one and sends the scopes the boxes describe', async () => {
    renderAccount();
    await screen.findByText('deploy pipeline');

    await userEvent.type(screen.getByRole('textbox', { name: /token name/i }), 'ci');
    await userEvent.click(screen.getByRole('checkbox', { name: /administer the panel/i }));
    await userEvent.click(screen.getByRole('button', { name: /create token/i }));

    const call = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/me/tokens') && o?.method === 'POST');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ name: 'ci', scopes: ['write', 'admin'], expiresAt: null });
  });

  it('shows the secret and keeps it on screen until it is dismissed', async () => {
    // There is no second chance to read it, so it must not be a toast that fades.
    renderAccount();
    await screen.findByText('deploy pipeline');

    await userEvent.type(screen.getByRole('textbox', { name: /token name/i }), 'ci');
    await userEvent.click(screen.getByRole('button', { name: /create token/i }));

    expect(await screen.findByText('nxi_the-only-time')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /i have copied it/i }));
    expect(screen.queryByText('nxi_the-only-time')).not.toBeInTheDocument();
  });

  it('revokes one', async () => {
    renderAccount();
    await screen.findByText('deploy pipeline');

    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

    const call = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/me/tokens/t1') && o?.method === 'DELETE');
    expect(call).toBeDefined();
  });
});
