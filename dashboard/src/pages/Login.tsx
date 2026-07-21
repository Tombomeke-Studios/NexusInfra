import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api';
import { setToken } from '../session';
import { IconHexagon } from '../components/Icons';

// Login form for the stub auth: exchange credentials for a JWT, store it, and
// enter the app. Credentials default to the seeded dev user for convenience.
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
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card__body">
          <span className="auth-brand">
            <IconHexagon size={22} />
            NexusInfra
          </span>
          <h1 style={{ fontSize: '1.4rem' }}>Sign in</h1>
          <p className="muted" style={{ marginTop: 4, marginBottom: 'var(--space-5)' }}>
            Server management panel
          </p>

          <form onSubmit={onSubmit}>
            <label className="field">
              <span className="field__label">Username</span>
              <input
                className="input"
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

            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy && <span className="spinner" />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="subtle" style={{ marginTop: 'var(--space-4)', fontSize: '0.82rem' }}>
            Dev credentials: <span className="mono">admin / admin</span>
          </p>
        </div>
      </div>
    </div>
  );
}
