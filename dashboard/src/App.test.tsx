import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { setToken, logout } from './session';
import { markIntroSeen } from './prefs';

// Shell behaviour: unauthenticated users are bounced to /login; authenticated
// users see the nav and the routed page.
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe('app shell', () => {
  // Routed pages fetch on mount; stub fetch so their async state updates settle.
  beforeEach(() => {
    logout();
    markIntroSeen(); // keep the first-run intro out of the shell assertions
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] } as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('redirects unauthenticated users to the login page', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders the nav shell when authenticated', () => {
    setToken('tok');
    renderAt('/');
    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New Deployment' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Servers' })).toBeInTheDocument();
  });

  // #247: on a phone the nav folds behind a Menu button. jsdom applies no media
  // queries, so this covers the state and what it tells assistive technology.
  it('opens and closes the menu, and says which it is', async () => {
    setToken('tok');
    renderAt('/servers');
    const toggle = screen.getByRole('button', { name: 'Menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'app-menu');

    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('app-menu')).toHaveClass('is-open');

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');

    // Choosing a page closes it too.
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await userEvent.click(screen.getByRole('link', { name: 'Teams' }));
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('routes to the servers page', () => {
    setToken('tok');
    renderAt('/servers');
    expect(screen.getByRole('heading', { name: 'Servers' })).toBeInTheDocument();
  });
});
