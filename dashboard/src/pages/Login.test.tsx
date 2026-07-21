import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Login } from './Login';
import { getToken } from '../api';
import { logout } from '../session';

// The login flow is driven against a mocked fetch: submitting stores the token
// and navigates into the app; a failed login surfaces the error.
function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>Overview page</div>} />
      </Routes>
    </MemoryRouter>
  );
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

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Overview page')).toBeInTheDocument();
    expect(getToken()).toBe('tok-xyz');
  });

  it('shows an error and stays on the page when credentials are rejected', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'invalid credentials' }),
    } as Response);
    renderLogin();

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid credentials');
    expect(getToken()).toBeNull();
  });
});
