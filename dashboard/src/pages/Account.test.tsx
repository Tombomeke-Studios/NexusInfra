import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Account } from './Account';
import { ToastProvider } from '../components/Toast';

// `GET /me` and `POST /me/password` shipped with accounts (#174) and no page ever
// called them, so changing your own password meant curl (#221).

const ME = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', platformRole: 'user', createdAt: new Date().toISOString() };

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
    fetchMock.mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => ME } as Response));
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
    fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) } as Response);

    await userEvent.type(screen.getByLabelText('Current password'), 'wrong-password');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'new-password');
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not your current password/i);
  });
});
