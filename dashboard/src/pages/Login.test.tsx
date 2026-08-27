import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Login } from './Login';
import { getToken } from '../api';
import { logout } from '../session';

// The login flow is driven against a mocked fetch: submitting stores the token
// and navigates into the app; a failed login surfaces the error.
function renderLogin(mode: 'sign-in' | 'register' = 'sign-in') {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login mode={mode} />} />
        <Route path="/" element={<div>Overview page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function fillCredentials(email = 'ada@example.com', password = 'lovelace1') {
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), password);
}

describe('Login', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    logout();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores the token and navigates on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok-xyz' }) } as Response);
    renderLogin();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Overview page')).toBeInTheDocument();
    expect(getToken()).toBe('tok-xyz');
  });

  it('signs in with the email the user typed', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok-xyz' }) } as Response);
    renderLogin();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByText('Overview page');
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toContain('/auth/login');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'ada@example.com', password: 'lovelace1' });
  });

  it('shows an error and stays on the page when credentials are rejected', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'invalid credentials' }),
    } as Response);
    renderLogin();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid credentials');
    expect(getToken()).toBeNull();
  });

  it('does not offer registration in the community edition', async () => {
    // useEdition defaults to community outside a provider, which is the point:
    // a self-hosted panel must not advertise a sign-up route that would 403.
    renderLogin();
    expect(screen.queryByRole('link', { name: 'Create one' })).not.toBeInTheDocument();
  });

  describe('registration', () => {
    it('registers against the register endpoint and signs the user straight in', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ token: 'tok-new', user: {} }) } as Response);
      renderLogin('register');

      await fillCredentials();
      await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

      expect(await screen.findByText('Overview page')).toBeInTheDocument();
      expect(getToken()).toBe('tok-new');
      expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/register');
    });

    it('surfaces the reason a registration was refused', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        json: async () => ({ error: 'an account with that email already exists' }),
      } as Response);
      renderLogin('register');

      await fillCredentials();
      await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
      expect(getToken()).toBeNull();
    });
  });
});

// ── Two-factor at the door (#229) ────────────────────────────────────────────

describe('Login with two-factor', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    logout();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for a code only once the password has been accepted', async () => {
    // The field is not shown up front: the server only says a code is needed to
    // someone who already got the password right, so neither should the panel.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'a two-factor code is required', totpRequired: true }),
    } as Response);
    renderLogin();

    expect(screen.queryByLabelText('Two-factor code')).not.toBeInTheDocument();
    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByLabelText('Two-factor code')).toBeInTheDocument();
  });

  it('sends the code with the credentials and signs in', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'code required', totpRequired: true }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tok-2fa' }) } as Response);
    renderLogin();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.type(await screen.findByLabelText('Two-factor code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Overview page')).toBeInTheDocument();
    expect(getToken()).toBe('tok-2fa');
    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(JSON.parse(last[1].body as string)).toMatchObject({ code: '123456' });
  });

  it('takes a recovery code in the same field', async () => {
    // One field for both kinds: which is which is a question about our
    // implementation, not about the person holding the code.
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'code required', totpRequired: true }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tok-recovery' }) } as Response);
    renderLogin();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.type(await screen.findByLabelText('Two-factor code'), 'AAAAA-11111');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Overview page')).toBeInTheDocument();
  });

  it('says so when the code is wrong, keeping the field', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'code required', totpRequired: true }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'not valid', totpRequired: true }) } as Response);
    renderLogin();

    await fillCredentials();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.type(await screen.findByLabelText('Two-factor code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
    expect(screen.getByLabelText('Two-factor code')).toBeInTheDocument();
  });
});
