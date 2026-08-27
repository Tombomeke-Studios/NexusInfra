import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  getCurrentUser,
  changePassword,
  listSessions,
  endSession,
  endOtherSessions,
  getTotpStatus,
  startTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  listApiTokens,
  createApiToken,
  revokeApiToken,
  ApiError,
  type ApiScope,
  type ApiTokenView,
  type CreatedApiToken,
  type CurrentUser,
  type SessionView,
  type TotpStatus,
} from '../api';
import { setToken } from '../session';
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

  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const loadSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

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
      toast('Password changed — every other session was signed out', 'success', 'Account');
      await loadSessions();
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

      <SessionsCard sessions={sessions} onChanged={loadSessions} />

      <TwoFactorCard />

      <TokensCard />

      <div className="card" style={{ padding: 24 }}>
        <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 6 }}>Change password</strong>
        <p className="subtle" style={{ margin: '0 0 18px', fontSize: '.84rem' }}>
          Your current password is required. Every other session is signed out, since changing a password is how you
          respond to thinking somebody else has it.
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

/**
 * Two-factor authentication (#229).
 *
 * Three states in one card: off, mid-enrolment, and on. The recovery codes are
 * shown once and stay on screen until dismissed, for the same reason an API
 * token's secret does — there is no second chance, and a toast that fades is not
 * somewhere to put the thing that gets you back in when your phone is gone.
 */
function TwoFactorCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [enrolling, setEnrolling] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getTotpStatus());
    } catch {
      setStatus({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrolling(await startTotpEnrolment());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start setting this up');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await confirmTotpEnrolment(code.trim());
      // The token that made this request predates the factor, so the server
      // hands back one that satisfies it. Using it keeps the session working
      // where the installation requires 2FA.
      setToken(result.token);
      setRecoveryCodes(result.recoveryCodes);
      setEnrolling(null);
      setCode('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code was not accepted');
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await disableTotp(password);
      setPassword('');
      toast('Two-factor authentication is off', 'success', 'Account');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn this off');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 24, marginBottom: 18 }}>
      <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 6 }}>
        Two-factor authentication
        <InfoHint text="A code from your phone, on top of your password. This panel can open a root shell inside your containers, so a password on its own is thin protection." label="Two-factor help" />
      </strong>

      {recoveryCodes && (
        <div className="alert alert--info" role="status" style={{ marginBottom: 16 }}>
          <strong style={{ display: 'block', marginBottom: 6 }}>Save these recovery codes — they are not shown again</strong>
          <p className="subtle" style={{ margin: '0 0 8px', fontSize: '.82rem' }}>
            Each one signs you in once if you lose your phone. Nobody can recover them for you.
          </p>
          <ul className="mono" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', columns: 2, fontSize: '.86rem' }}>
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button className="btn btn--secondary btn--sm" data-ripple type="button" onClick={() => setRecoveryCodes(null)}>
            I have saved them
          </button>
        </div>
      )}

      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 14 }}>{error}</p>}

      {status === null ? (
        <div className="empty">Loading…</div>
      ) : status.enabled ? (
        <>
          <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>
            On since {new Date(status.enabledAt ?? Date.now()).toLocaleDateString()} ·{' '}
            {status.recoveryCodesRemaining} recovery {status.recoveryCodesRemaining === 1 ? 'code' : 'codes'} left.
          </p>
          <form onSubmit={disable} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Your password"
              aria-label="Password, to turn two-factor off"
              style={{ width: 'auto', minWidth: 220 }}
            />
            <button className="btn btn--secondary btn--sm" data-ripple type="submit" disabled={busy || !password}>
              Turn off
            </button>
          </form>
          <p className="subtle" style={{ margin: '10px 0 0', fontSize: '.8rem' }}>
            Your password is required — holding this session is not enough.
          </p>
        </>
      ) : enrolling ? (
        <>
          <p className="subtle" style={{ margin: '0 0 12px', fontSize: '.84rem' }}>
            Add this to your authenticator app, then type the code it shows. Nothing changes until you do.
          </p>
          <code className="mono" style={{ display: 'block', wordBreak: 'break-all', marginBottom: 6 }}>{enrolling.secret}</code>
          <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.8rem' }}>
            Some apps take the whole link instead: <span className="mono" style={{ wordBreak: 'break-all' }}>{enrolling.otpauthUrl}</span>
          </p>
          <form onSubmit={confirm} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
              placeholder="123456"
              aria-label="Code from your authenticator app"
              style={{ width: 'auto', minWidth: 160 }}
            />
            <button className="btn btn--primary btn--sm" data-ripple type="submit" disabled={busy || !code.trim()}>
              Turn on
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>
            Off. Turning it on asks for a code from your phone every time you sign in, and gives you recovery codes for
            the day the phone is gone.
          </p>
          <button className="btn btn--primary btn--sm" data-ripple type="button" disabled={busy} onClick={() => void start()}>
            Set up two-factor
          </button>
        </>
      )}
    </div>
  );
}

/**
 * API tokens (#228) — a credential a script can hold instead of your password.
 *
 * The secret appears exactly once, in the response that creates it. The card
 * keeps that one on screen until it is dismissed, because there is no second
 * chance and a toast that fades is not somewhere to put a credential.
 */
function TokensCard() {
  const { toast } = useToast();
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await listApiTokens();
      // An older panel talking to an installation without this route gets
      // whatever that path does return; an empty card is a better answer than a
      // page that fails to render.
      setTokens(Array.isArray(list) ? list : []);
    } catch {
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const scopes: ApiScope[] = [...(write ? (['write'] as const) : []), ...(admin ? (['admin'] as const) : [])];
      setCreated(await createApiToken(name.trim(), scopes));
      setName('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create that token', 'error', 'API tokens');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: ApiTokenView) => {
    setBusy(true);
    try {
      await revokeApiToken(token.id);
      toast(`“${token.name}” was revoked and stops working immediately`, 'success', 'API tokens');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not revoke that token', 'error', 'API tokens');
    } finally {
      setBusy(false);
    }
  };

  const describe = (scopes: ApiScope[]) =>
    scopes.includes('admin') ? 'Read, write and panel administration' : scopes.includes('write') ? 'Read and write' : 'Read only';

  return (
    <div className="card" style={{ padding: 24, marginBottom: 18 }}>
      <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 6 }}>
        API tokens
        <InfoHint text="A credential for scripts and CI, used in place of your password. It acts as you, can be limited to reading only, and can be revoked on its own without affecting how you sign in." label="API tokens help" />
      </strong>
      <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>
        Send it as <code>Authorization: Bearer …</code>. A token can never do more than your account can.
      </p>

      {created && (
        <div className="alert alert--info" role="status" style={{ marginBottom: 16 }}>
          <strong style={{ display: 'block', marginBottom: 6 }}>Copy this now — it is not shown again</strong>
          <code className="mono" style={{ display: 'block', wordBreak: 'break-all', marginBottom: 10 }}>{created.secret}</code>
          <button className="btn btn--secondary btn--sm" data-ripple type="button" onClick={() => setCreated(null)}>
            I have copied it
          </button>
        </div>
      )}

      {tokens === null ? (
        <div className="empty">Loading…</div>
      ) : tokens.length === 0 ? (
        <div className="empty">No tokens yet.</div>
      ) : (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 16 }}>
          {tokens.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 180 }}>
                <span style={{ display: 'block', fontSize: '.86rem' }}>{t.name}</span>
                <span className="subtle" style={{ fontSize: '.78rem' }}>
                  {describe(t.scopes)} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}
                </span>
              </span>
              <button className="btn btn--secondary btn--sm" data-ripple disabled={busy} onClick={() => void revoke(t)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={create} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="What is it for? e.g. deploy pipeline"
          aria-label="Token name"
          style={{ width: 'auto', minWidth: 240 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.84rem' }}>
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} /> Can change things
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.84rem' }}>
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Can administer the panel
        </label>
        <button className="btn btn--primary btn--sm" data-ripple type="submit" disabled={busy || !name.trim()}>
          Create token
        </button>
      </form>
    </div>
  );
}

/**
 * Where this account is signed in, and how to stop being (#227).
 *
 * A token used to stay valid until it expired whatever happened to the account,
 * so this list is the first thing that can answer "is anyone else signed in as
 * me" — and the buttons are the first that can do anything about it.
 */
function SessionsCard({ sessions, onChanged }: { sessions: SessionView[] | null; onChanged: () => Promise<void> | void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const others = (sessions ?? []).filter((s) => !s.current);

  const end = async (session: SessionView) => {
    setBusy(true);
    try {
      await endSession(session.id);
      toast('That session was signed out', 'success', 'Sessions');
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not end that session', 'error', 'Sessions');
    } finally {
      setBusy(false);
    }
  };

  const endAll = async () => {
    if (!window.confirm('Sign out everywhere else? Other devices will have to sign in again.')) return;
    setBusy(true);
    try {
      await endOtherSessions();
      toast('Every other session was signed out', 'success', 'Sessions');
      await onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not end the other sessions', 'error', 'Sessions');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 24, marginBottom: 18 }}>
      <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 6 }}>
        Signed in on
        <InfoHint text="Every device you are signed in on. Ending one stops its token working immediately, rather than whenever it would have expired." label="Sessions help" />
      </strong>
      <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>
        Anything here that you do not recognise can be signed out.
      </p>

      {sessions === null ? (
        <div className="empty">Loading…</div>
      ) : (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}
            >
              <span style={{ flex: 1, minWidth: 180 }}>
                <span style={{ display: 'block', fontSize: '.86rem' }}>
                  {s.userAgent || 'Unknown device'}
                  {s.current && <span className="badge badge--info" style={{ marginLeft: 8 }}>this device</span>}
                </span>
                <span className="subtle mono" style={{ fontSize: '.78rem' }}>
                  {s.ipAddress ?? 'unknown address'} · last used {new Date(s.lastSeenAt).toLocaleString()}
                </span>
              </span>
              {!s.current && (
                <button className="btn btn--secondary btn--sm" data-ripple disabled={busy} onClick={() => void end(s)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <button className="btn btn--danger btn--sm" data-ripple disabled={busy} style={{ marginTop: 14 }} onClick={() => void endAll()}>
          Sign out everywhere else ({others.length})
        </button>
      )}
    </div>
  );
}
