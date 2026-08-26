import { useEffect, useState, type FormEvent } from 'react';
import { getCurrentUser, changePassword, ApiError, type CurrentUser } from '../api';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';

// Account (#221) — who you are signed in as, and the one thing you can change
// about yourself. `GET /me` and `POST /me/password` had existed since accounts
// landed (#174) and nothing in the panel ever called them, so changing your own
// password meant curl.
//
// Platform role is deliberately read-only here: your own standing is not yours to
// raise. Administrators grant it from the Users page.
export function Account() {
  const { toast } = useToast();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((u) => active && setUser(u))
      .catch((e) => active && setLoadError(e instanceof Error ? e.message : 'Could not load your account'));
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    // Checked here only to save a round trip; the API is the real gate on both.
    if (next !== confirm) return setError('The new password and its confirmation do not match');
    if (next.length < 8) return setError('The new password must be at least 8 characters');

    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast('Password changed', 'success', 'Account');
    } catch (e) {
      // A wrong current password is 401 — say so plainly rather than as a status.
      setError(e instanceof ApiError && e.status === 401 ? 'That is not your current password' : e instanceof Error ? e.message : 'Could not change your password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '32px 24px', animation: 'rise 320ms var(--ease-out) both' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 6 }}>Account</h1>
      <p className="subtle" style={{ marginBottom: 24, fontSize: '.88rem' }}>
        The account you are signed in as, and your password.
      </p>

      {loadError && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{loadError}</p>}

      <div className="card" style={{ padding: 24, marginBottom: 18 }}>
        <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 16 }}>Signed in as</strong>
        {user ? (
          <dl style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '10px 16px', fontSize: '.88rem', margin: 0 }}>
            <dt className="muted">Name</dt>
            <dd style={{ margin: 0 }}>{user.displayName}</dd>
            <dt className="muted">Email</dt>
            <dd className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>{user.email}</dd>
            <dt className="muted">
              Platform role
              <InfoHint text="Your panel-wide standing: who may manage nodes and accounts. Separate from your role on an individual server, which is granted per server or through a team." label="Platform role help" />
            </dt>
            <dd style={{ margin: 0, textTransform: 'capitalize' }}>{user.platformRole}</dd>
          </dl>
        ) : (
          !loadError && <div className="empty">Loading…</div>
        )}
      </div>

      <div className="card" style={{ padding: 24 }}>
        <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 6 }}>Change password</strong>
        <p className="subtle" style={{ margin: '0 0 18px', fontSize: '.84rem' }}>
          Your current password is required. Existing sessions are not signed out yet — that is tracked separately.
        </p>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="current-password">Current password</label>
            <input id="current-password" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="new-password">New password</label>
            <input id="new-password" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="confirm-password">Confirm new password</label>
            <input id="confirm-password" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>

          {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{error}</p>}

          <button type="submit" className="btn btn--primary" data-ripple data-burst="success" disabled={busy} style={{ minHeight: 42 }}>
            {busy && <span className="spinner" />}
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </form>
      </div>
    </div>
  );
}
