import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { logout } from '../session';
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
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());

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
        </nav>
        <ThemeToggle />
        <button className="btn btn--ghost btn--sm" onClick={() => setIntroOpen(true)} data-ripple aria-label="Open the intro tour" title="Intro & help">
          Help
        </button>
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
