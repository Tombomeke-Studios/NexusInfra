import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Users } from './Users';
import { ToastProvider } from '../components/Toast';

// `GET /users` and `POST /users` shipped with accounts (#174) and no page called
// them, so onboarding a second person in the community edition — where people do
// not register themselves — meant curl (#222).

const ADMIN = { id: 'u1', email: 'root@example.com', displayName: 'Root', platformRole: 'admin', createdAt: new Date().toISOString() };
const LIST = [ADMIN, { id: 'u2', email: 'ada@example.com', displayName: 'Ada', platformRole: 'user', createdAt: new Date().toISOString() }];

function renderUsers() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <Users />
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Users', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, status: 200, json: async () => (String(url).includes('/me') ? ADMIN : LIST) } as Response)
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the accounts with their platform role', async () => {
    renderUsers();
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('root@example.com')).toBeInTheDocument();
    expect(screen.getByText('2 accounts')).toBeInTheDocument();
  });

  it('creates an account with the chosen role', async () => {
    renderUsers();
    await screen.findByText('ada@example.com');

    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.type(screen.getByLabelText(/initial password/i), 'first-password');
    await userEvent.click(screen.getByRole('button', { name: 'admin' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const call = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith('/users') && o?.method === 'POST');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toMatchObject({
      email: 'new@example.com',
      password: 'first-password',
      platformRole: 'admin',
    });
  });

  it('explains a 403 rather than showing an empty list', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/me')
        ? Promise.resolve({ ok: true, status: 200, json: async () => ADMIN } as Response)
        : Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) } as Response)
    );
    renderUsers();

    expect(await screen.findByRole('alert')).toHaveTextContent(/only platform administrators/i);
  });
  it('resets a password and warns that it signs the account out', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('a-fresh-start');
    renderUsers();
    await screen.findByText('ada@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Reset the password for ada@example.com' }));

    const call = fetchMock.mock.calls.find(([u, o]) => String(u).includes('/users/u2/password') && o?.method === 'POST');
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ newPassword: 'a-fresh-start' });
  });

  it('does nothing when the prompt is cancelled', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    renderUsers();
    await screen.findByText('ada@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'Reset the password for ada@example.com' }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/password'))).toBe(false);
  });
});
