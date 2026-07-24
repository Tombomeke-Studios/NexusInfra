import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api';
import { setToken } from '../session';
import { IconHexagon } from '../components/Icons';
import { ThemeToggle } from '../components/ThemeToggle';

// Login screen — ported from the redesign (NexusInfra.dc.html): aurora backdrop
// (App-level), a spotlight card with a floaty brand, and a magnetic/ripple
// primary button (FX activated by the interaction layer).
export function Login() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await login(username, password);
      setToken(token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 392, animation: 'rise 520ms var(--ease-out) both' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
          <ThemeToggle />
        </div>

        <div className="card spotlight" data-spotlight style={{ overflow: 'hidden' }}>
          <div style={{ padding: '28px 26px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 9,
                fontWeight: 700,
                color: 'var(--color-primary)',
                marginBottom: 18,
                fontSize: '1.05rem',
              }}
            >
              <span style={{ display: 'inline-flex', animation: 'floaty 4s ease-in-out infinite' }}>
                <IconHexagon size={22} />
              </span>
              NexusInfra
            </span>

            <h1 style={{ fontSize: '1.4rem' }}>Sign in</h1>
            <p style={{ color: 'var(--color-text-muted)', margin: '4px 0 22px' }}>Server management panel</p>

            <form onSubmit={onSubmit}>
              <label className="field">
                <span className="field__label">Username</span>
                <input
                  className="input"
                  aria-label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </label>

              <label className="field">
                <span className="field__label">Password</span>
                <span className="input-wrap">
                  <input
                    className="input"
                    aria-label="Password"
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm input-affix"
                    onClick={() => setShowPw((v) => !v)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </span>
              </label>

              {error && (
                <p role="alert" className="alert alert--error" style={{ marginBottom: 'var(--space-4)' }}>
                  {error}
                </p>
              )}

              <button type="submit" className="btn btn--primary btn--block" data-magnetic data-ripple data-burst="primary" disabled={busy}>
                {busy && <span className="spinner" />}
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <p className="subtle" style={{ marginTop: 16, fontSize: '0.82rem' }}>
              Dev credentials: <span className="mono">admin / admin</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
