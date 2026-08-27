import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Teams } from './Teams';
import { ToastProvider } from '../components/Toast';
import { DialogProvider } from '../components/Dialog';

// The Teams page is driven against a mocked fetch keyed by path, so the tests
// exercise the real component against realistic responses.

const ME = { id: 'user-lead', email: 'lead@example.com', displayName: 'Lead', platformRole: 'user', createdAt: '' };
const TEAM = { id: 'team-1', name: 'Platform', ownerId: ME.id, createdAt: '' };
const MEMBER = { id: 'm1', teamId: TEAM.id, userId: 'user-member', email: 'member@example.com', displayName: 'Member', role: 'operator', createdAt: '' };

function renderTeams() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <DialogProvider>
          <Teams />
        </DialogProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Teams', () => {
  const fetchMock = vi.fn();

  /** Answer by path, so the component's real call sequence is exercised. */
  function routes(handlers: Record<string, unknown>, meId = ME.id) {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url);
      const key = Object.keys(handlers).find((k) => path.includes(k));
      const body = key ? handlers[key] : path.includes('/me') ? { ...ME, id: meId } : {};
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('invites people to join and lists them with their role', async () => {
    routes({ '/teams/team-1': { ...TEAM, members: [MEMBER] }, '/teams': [TEAM] });
    renderTeams();

    expect(await screen.findByText('Member')).toBeInTheDocument();
    expect(screen.getByText(/Start, stop, restart/)).toBeInTheDocument();
  });

  it('prompts to create a team when there are none', async () => {
    routes({ '/teams': [] });
    renderTeams();

    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument();
  });

  it('creates a team from the form', async () => {
    routes({ '/teams/team-1': { ...TEAM, members: [] }, '/teams': [] });
    renderTeams();
    await screen.findByText(/No teams yet/);

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/teams') && init?.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: async () => TEAM } as Response);
      if (path.includes('/teams/team-1')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...TEAM, members: [] }) } as Response);
      if (path.includes('/teams')) return Promise.resolve({ ok: true, status: 200, json: async () => [TEAM] } as Response);
      return Promise.resolve({ ok: true, status: 200, json: async () => ME } as Response);
    });

    await userEvent.type(screen.getByLabelText('New team name'), 'Platform');
    await userEvent.click(screen.getByRole('button', { name: 'Create team' }));

    await waitFor(() => expect(screen.getByText('You own this team')).toBeInTheDocument());
  });

  it('offers membership controls to the team owner', async () => {
    routes({ '/teams/team-1': { ...TEAM, members: [MEMBER] }, '/teams': [TEAM] });
    renderTeams();

    expect(await screen.findByRole('button', { name: 'Add member' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete team' })).toBeInTheDocument();
    expect(screen.getByLabelText('Role for Member')).toBeInTheDocument();
  });

  it('hides membership controls from a member who does not own the team', async () => {
    // The API enforces this as well — hiding the controls only avoids offering
    // an action that would be refused.
    routes({ '/teams/team-1': { ...TEAM, members: [MEMBER] }, '/teams': [TEAM] }, 'user-member');
    renderTeams();

    expect(await screen.findByText('You are a member')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete team' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Role for Member')).not.toBeInTheDocument();
  });

  it('lets a member leave, but not remove anyone else', async () => {
    const other = { ...MEMBER, id: 'm2', userId: 'user-other', displayName: 'Other', email: 'other@example.com' };
    routes({ '/teams/team-1': { ...TEAM, members: [MEMBER, other] }, '/teams': [TEAM] }, 'user-member');
    renderTeams();

    expect(await screen.findByRole('button', { name: 'Leave this team' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Other' })).not.toBeInTheDocument();
  });
});
