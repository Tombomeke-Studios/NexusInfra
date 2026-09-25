import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsCard } from './NotificationsCard';
import { ToastProvider } from './Toast';
import { DialogProvider } from './Dialog';

function renderCard(settings: unknown, extra: (url: string, init?: RequestInit) => unknown = () => ({})) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const body = String(url).endsWith('/me/notifications') && (!init?.method || init.method === 'GET') ? settings : extra(String(url), init);
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <ToastProvider>
      <DialogProvider>
        <NotificationsCard />
      </DialogProvider>
    </ToastProvider>
  );
  return fetchMock;
}

describe('NotificationsCard (#236)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const empty = { channels: [], capabilities: { email: false, events: ['server.crashed', 'server.suspended'] } };

  it('adds a Discord webhook for crashes', async () => {
    const fetchMock = renderCard(empty, () => ({ id: 'c1', secret: 'abc123' }));
    await userEvent.type(await screen.findByLabelText('Webhook URL'), 'https://discord.com/api/webhooks/1/x');
    await userEvent.selectOptions(screen.getByLabelText('Webhook format'), 'discord');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, o]) => String(u).endsWith('/me/notifications') && o?.method === 'POST');
      expect(JSON.parse(String(post![1]!.body))).toEqual({ kind: 'webhook', target: 'https://discord.com/api/webhooks/1/x', format: 'discord', events: ['server.crashed'] });
    });
    expect(await screen.findByText('abc123')).toBeInTheDocument();
  });

  it('offers email only when the installation can send it', async () => {
    renderCard(empty);
    await screen.findByLabelText('Channel kind');
    expect(screen.queryByRole('option', { name: 'Email to me' })).not.toBeInTheDocument();
    expect(screen.getByText(/Email is not configured/)).toBeInTheDocument();
  });

  it('shows what went wrong with a channel, so a broken URL is found before it matters', async () => {
    renderCard({
      ...empty,
      channels: [{ id: 'c1', kind: 'webhook', target: 'https://x.io/h', format: 'json', events: ['server.crashed'], enabled: true, signed: true, lastDeliveryAt: null, lastError: 'the endpoint answered 404', createdAt: '' }],
    });
    expect(await screen.findByText(/last attempt failed: the endpoint answered 404/)).toBeInTheDocument();
  });

  it('stays out of the way when the orchestrator does not offer notifications', async () => {
    renderCard({ id: 'u1', email: 'a@b.c' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
  });
});
