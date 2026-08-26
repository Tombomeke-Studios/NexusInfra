import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { getCurrentUser, type CurrentUser } from '../api';
import { logout } from '../session';
import { useEdition } from '../edition';
import { BILLING_INCLUDED } from '../buildEdition';
import { hasSeenIntro, markIntroSeen } from '../prefs';
import { ThemeToggle } from './ThemeToggle';
import { IntroTour } from './IntroTour';
import { IconHexagon, IconLogout } from './Icons';

// App shell: sticky top bar with brand, primary nav, theme toggle, a help entry
// point, and a sign-out action kept separate from navigation. The routed page
// renders in the <Outlet/>. The first-run intro (#123) opens automatically.
export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isHosted } = useEdition();
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());
  const [user, setUser] = useState<CurrentUser | null>(null);
  const isPlatformAdmin = user?.platformRole === 'admin' || user?.platformRole === 'owner';

  // Who am I? Shown in the bar so it's never ambiguous which account is acting —
  // that matters once servers are shared between people (#174).
  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((u) => active && setUser(u))
      .catch(() => undefined); // the sign-out path already handles a dead session
    return () => {
      active = false;
    };
  }, []);

  const closeIntro = () => {
    markIntroSeen();
    setIntroOpen(false);
  };

  const signOut = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div>
      <header className="appbar">
        <span className="appbar__brand">
          <IconHexagon size={20} />
          NexusInfra
        </span>
        <nav className="appbar__nav" aria-label="Primary">
          <NavLink to="/" end className="navlink" data-ripple>
            Overview
          </NavLink>
          <NavLink to="/new" className="navlink" data-ripple>
            New Deployment
          </NavLink>
          <NavLink to="/servers" className="navlink" data-ripple>
            Servers
          </NavLink>
          <NavLink to="/teams" className="navlink" data-ripple>
            Teams
          </NavLink>
          <NavLink to="/preferences" className="navlink" data-ripple>
            Preferences
          </NavLink>
          {/* Account administration is admin-only. Hiding the link is convenience,
              not security — /users answers 403 to anyone else regardless (#222). */}
          {isPlatformAdmin && (
            <NavLink to="/users" className="navlink" data-ripple>
              Accounts
            </NavLink>
          )}
          {/* Not in a community build at all (#190), so the bundler drops it. */}
          {BILLING_INCLUDED && isHosted && (
            <NavLink to="/billing" className="navlink" data-ripple>
              Billing
            </NavLink>
          )}
        </nav>
        <ThemeToggle />
        <button className="btn btn--ghost btn--sm" onClick={() => setIntroOpen(true)} data-ripple aria-label="Open the intro tour" title="Intro & help">
          Help
        </button>
        {user && (
          <NavLink
            to="/account"
            className="navlink"
            data-ripple
            style={{ fontSize: '0.82rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={`${user.email} · ${user.platformRole} — open your account`}
          >
            {user.displayName}
          </NavLink>
        )}
        <button className="btn btn--ghost btn--sm" onClick={signOut} data-ripple>
          <IconLogout size={16} />
          Sign out
        </button>
      </header>
      <main>
        <div key={location.pathname} className="route-view">
          <Outlet />
        </div>
      </main>
      <IntroTour open={introOpen} onClose={closeIntro} />
    </div>
  );
}
