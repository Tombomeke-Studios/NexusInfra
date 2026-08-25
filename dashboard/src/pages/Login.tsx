import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, register } from '../api';
import { setToken } from '../session';
import { useEdition } from '../edition';
import { IconHexagon } from '../components/Icons';
import { ThemeToggle } from '../components/ThemeToggle';

// Login screen — ported from the redesign (NexusInfra.dc.html): aurora backdrop
// (App-level), a spotlight card with a floaty brand, and a magnetic/ripple
// primary button (FX activated by the interaction layer).
export function Login({ mode = 'sign-in' }: { mode?: 'sign-in' | 'register' }) {
  const registering = mode === 'register';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { isHosted } = useEdition();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = registering ? await register(email, password) : await login(email, password);
      setToken(token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : registering ? 'Could not create the account' : 'Login failed');
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

            <h1 style={{ fontSize: '1.4rem' }}>{registering ? 'Create your account' : 'Sign in'}</h1>
            <p style={{ color: 'var(--color-text-muted)', margin: '4px 0 22px' }}>Server management panel</p>

            <form onSubmit={onSubmit}>
              <label className="field">
                <span className="field__label">Email</span>
                <input
                  className="input"
                  aria-label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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
                    autoComplete={registering ? 'new-password' : 'current-password'}
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
                {busy ? (registering ? 'Creating account…' : 'Signing in…') : registering ? 'Create account' : 'Sign in'}
              </button>
            </form>

            {/* Only the hosted edition lets people sign themselves up; on a
                self-hosted panel an administrator creates the accounts. */}
            {isHosted && (
              <p className="subtle" style={{ marginTop: 16, fontSize: '0.82rem' }}>
                {registering ? (
                  <>
                    Already have an account? <Link to="/login">Sign in</Link>
                  </>
                ) : (
                  <>
                    No account yet? <Link to="/register">Create one</Link>
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
