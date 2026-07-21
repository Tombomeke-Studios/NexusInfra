import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout } from '../session';

// App shell: brand + primary navigation, with the active page rendered in the
// <Outlet/>. Shown only inside the authenticated area.
const linkStyle = ({ isActive }: { isActive: boolean }) => ({
  marginRight: '1rem',
  fontWeight: isActive ? 700 : 400,
  color: isActive ? '#1d4ed8' : '#334155',
  textDecoration: 'none',
});

export function Layout() {
  const navigate = useNavigate();

  const signOut = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '1rem 1.5rem',
          borderBottom: '1px solid #e2e8f0',
        }}
      >
        <strong style={{ fontSize: '1.1rem' }}>NexusInfra</strong>
        <nav style={{ flex: 1 }}>
          <NavLink to="/" end style={linkStyle}>
            Overview
          </NavLink>
          <NavLink to="/new" style={linkStyle}>
            New Deployment
          </NavLink>
          <NavLink to="/servers" style={linkStyle}>
            Servers
          </NavLink>
        </nav>
        <button onClick={signOut}>Sign out</button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
