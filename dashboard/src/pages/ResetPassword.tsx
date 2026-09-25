import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { confirmPasswordReset } from '../api';
import { IconHexagon } from '../components/Icons';

// Where the reset link in the mail lands (#344). Public: somebody who forgot
// their password has no session. The token in the link is the only credential,
// and it is spent by the first accepted submission.

/** The same floor the server applies, checked here so a typo does not cost a round trip. */
const MIN_LENGTH = 8;

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const problem =
    password.length > 0 && password.length < MIN_LENGTH
      ? `At least ${MIN_LENGTH} characters`
      : again.length > 0 && again !== password
        ? 'The two passwords differ'
        : null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !password) return;
    setBusy(true);
    setError(null);
    try {
      await confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 392, padding: '28px 26px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontWeight: 700, color: 'var(--color-primary)', marginBottom: 18 }}>
          <IconHexagon size={22} />
          NexusInfra
        </span>
        <h1 style={{ fontSize: '1.4rem' }}>Choose a new password</h1>

        {!token ? (
          <p role="alert" className="alert alert--error" style={{ marginTop: 16 }}>
            This page needs the link from the reset email. Open the link from the mail, or ask for a new one on the sign-in page.
          </p>
        ) : done ? (
          <>
            <p role="status" className="alert alert--success" style={{ marginTop: 16 }}>
              Your password has been changed, and every place you were signed in has been signed out.
            </p>
            <Link className="btn btn--primary btn--block" to="/login" style={{ marginTop: 12 }}>
              Sign in
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} style={{ marginTop: 16 }}>
            <label className="field">
              <span className="field__label">New password</span>
              <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </label>
            <label className="field">
              <span className="field__label">New password, again</span>
              <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
            </label>
            {(problem || error) && (
              <p role="alert" className="alert alert--error" style={{ marginBottom: 'var(--space-4)' }}>
                {problem ?? error}
              </p>
            )}
            <button type="submit" className="btn btn--primary btn--block" disabled={busy || !password || again !== password || Boolean(problem)}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
            {error && (
              <p style={{ marginTop: 12, fontSize: '0.82rem' }}>
                <Link to="/login">Ask for a new link</Link>
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
