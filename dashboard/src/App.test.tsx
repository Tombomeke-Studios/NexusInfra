import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from './routes';
import { setToken, logout } from './session';

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

  it('routes to the servers page', () => {
    setToken('tok');
    renderAt('/servers');
    expect(screen.getByRole('heading', { name: 'Servers' })).toBeInTheDocument();
  });
});
