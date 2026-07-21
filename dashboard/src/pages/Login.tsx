import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../api';
import { setToken } from '../session';

// Login form for the stub auth: exchange credentials for a JWT, store it, and
// enter the app. Credentials default to the seeded dev user for convenience.
export function Login() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
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
    <main style={{ maxWidth: 360 }}>
      <h1>Sign in</h1>
      <p style={{ color: '#64748b', marginTop: '-0.5rem' }}>NexusInfra server panel</p>
      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>
          Username
          <input
            style={{ display: 'block', width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>
          Password
          <input
            type="password"
            style={{ display: 'block', width: '100%', padding: '0.5rem', marginTop: '0.25rem' }}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && (
          <p role="alert" style={{ color: '#dc2626' }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
