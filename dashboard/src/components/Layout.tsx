import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout } from '../session';
import { ThemeToggle } from './ThemeToggle';
import { IconHexagon, IconLogout } from './Icons';

// App shell: sticky top bar with brand, primary nav, theme toggle, and a
// sign-out action kept separate from navigation. The routed page renders in the
// <Outlet/>.
export function Layout() {
  const navigate = useNavigate();

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
          <NavLink to="/" end className="navlink">
            Overview
          </NavLink>
          <NavLink to="/new" className="navlink">
            New Deployment
          </NavLink>
          <NavLink to="/servers" className="navlink">
            Servers
          </NavLink>
        </nav>
        <ThemeToggle />
        <button className="btn btn--ghost btn--sm" onClick={signOut}>
          <IconLogout size={16} />
          Sign out
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
