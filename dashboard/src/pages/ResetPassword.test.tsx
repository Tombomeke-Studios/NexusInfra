import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ResetPassword } from './ResetPassword';

// Where the mailed link lands (#344).

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/login" element={<div>Sign-in page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function answer(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(async () => ({ ok: status < 300, status, statusText: '', json: async () => body }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('ResetPassword', () => {
  it('sets the new password with the token from the link', async () => {
    const fetchMock = answer(204);
    renderAt('/reset-password?token=tok-123');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password-2');
    await userEvent.type(screen.getByLabelText('New password, again'), 'new-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Your password has been changed');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/auth\/password-reset\/confirm$/);
    expect(JSON.parse(String(init.body))).toEqual({ token: 'tok-123', newPassword: 'new-password-2' });
  });

  it('catches a short or mistyped password before spending a round trip', async () => {
    const fetchMock = answer(204);
    renderAt('/reset-password?token=tok-123');
    await userEvent.type(screen.getByLabelText('New password'), 'short');
    expect(screen.getByRole('alert')).toHaveTextContent('At least 8 characters');
    await userEvent.type(screen.getByLabelText('New password'), '-enough');
    await userEvent.type(screen.getByLabelText('New password, again'), 'different');
    expect(screen.getByRole('alert')).toHaveTextContent('The two passwords differ');
    expect(screen.getByRole('button', { name: 'Set new password' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says a spent or expired link is spent, and where to get another', async () => {
    answer(400, { error: 'this reset link is invalid, has expired, or has already been used' });
    renderAt('/reset-password?token=old');
    await userEvent.type(screen.getByLabelText('New password'), 'new-password-2');
    await userEvent.type(screen.getByLabelText('New password, again'), 'new-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has already been used');
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toBeInTheDocument();
  });

  it('explains itself when opened without a link', () => {
    renderAt('/reset-password');
    expect(screen.getByRole('alert')).toHaveTextContent('needs the link from the reset email');
  });
});
