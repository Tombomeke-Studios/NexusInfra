import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { getCurrentUser, logoutSession, type CurrentUser } from '../api';
import { logout } from '../session';
import { useEdition } from '../edition';
import { BILLING_INCLUDED } from '../buildEdition';
import { hasSeenIntro, markIntroSeen } from '../prefs';
import { ThemeToggle } from './ThemeToggle';
import { IntroTour } from './IntroTour';
import { IconHexagon, IconLogout } from './Icons';
import { nextNavFit, type NavFitState } from '../navFit';

// App shell: sticky top bar with brand, primary nav, theme toggle, a help entry
// point, and a sign-out action kept separate from navigation. The routed page
// renders in the <Outlet/>. The first-run intro (#123) opens automatically.
export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isHosted } = useEdition();
  const [introOpen, setIntroOpen] = useState(() => !hasSeenIntro());
  const [user, setUser] = useState<CurrentUser | null>(null);
  // When the bar does not fit, the nav and its actions fold behind a Menu button
  // (#247) — a row of eight links does not fit a phone, and the whole page used
  // to scroll sideways because of it. *When* is measured, not a fixed width
  // (#352): how much the bar holds depends on the edition and the role. Closed
  // again by navigating or Escape.
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const [fit, setFit] = useState<NavFitState>({ compact: false, neededWidth: null });
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const isPlatformAdmin = user?.platformRole === 'admin' || user?.platformRole === 'owner';

  // Measured before paint, so the bar never shows overflowing for a frame.
  const measureBar = () => {
    const el = headerRef.current;
    if (el) setFit((s) => nextNavFit(s, { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
  };
  // A different set of links (the account loaded, the edition resolved) needs a
  // fresh measurement of the full bar.
  const barContent = `${isPlatformAdmin}|${isHosted}|${user?.displayName ?? ''}`;
  useLayoutEffect(() => setFit({ compact: false, neededWidth: null }), [barContent]);
  useLayoutEffect(measureBar, [fit, barContent]);
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measureBar());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!fit.compact) setMenuOpen(false);
  }, [fit.compact]);

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
    // Ends the session server-side too (#227). Clearing the token locally used to
    // be the whole of "sign out", which left it working for anyone holding a copy
    // until it expired. Fire-and-forget: a failure here must not trap someone on a
    // page they are trying to leave, and the local token goes either way.
    void logoutSession().catch(() => undefined);
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div>
      <header ref={headerRef} className={`appbar${fit.compact ? ' appbar--compact' : ''}`}>
        <span className="appbar__brand">
          <IconHexagon size={20} />
          NexusInfra
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm appbar__menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="app-menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
        <div id="app-menu" className={`appbar__menu${menuOpen ? ' is-open' : ''}`}>
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
        </div>
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
