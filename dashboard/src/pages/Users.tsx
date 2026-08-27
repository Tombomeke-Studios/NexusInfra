import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { listUsers, createUser, getCurrentUser, resetUserPassword, ApiError, type CurrentUser, type PlatformRole } from '../api';
import { useToast } from '../components/Toast';
import { useDialog } from '../components/Dialog';
import { InfoHint } from '../components/InfoHint';
import { formatRelative } from '../format';

// Users (#222) — the administrator's view of who can sign in, and how somebody
// new gets an account.
//
// This matters most in the community edition, where self-registration is closed
// by design: an administrator creates accounts. `GET /users` and `POST /users`
// existed since #174 and no page ever called them, so onboarding a second person
// meant curl.
//
// The nav hides this page from non-administrators, but that is cosmetic — the API
// answers 403 regardless, which is the real gate.

const ROLES: PlatformRole[] = ['user', 'admin', 'owner'];

const ROLE_HELP: Record<PlatformRole, string> = {
  user: 'Can deploy and manage their own servers, and anything shared with them.',
  admin: 'Everything a user can, plus managing nodes and creating accounts.',
  owner: 'Full control of the installation.',
};

export function Users() {
  const { toast } = useToast();
  const { prompt } = useDialog();
  const [users, setUsers] = useState<CurrentUser[] | null>(null);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [platformRole, setPlatformRole] = useState<PlatformRole>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await listUsers());
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof ApiError && e.status === 403
          ? 'Only platform administrators can manage accounts.'
          : e instanceof Error
            ? e.message
            : 'Could not load accounts'
      );
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void getCurrentUser().then(setMe).catch(() => undefined);
  }, [load]);

  // Resetting a password is how somebody gets back in when they have forgotten
  // theirs; there is no mail server to assume in the community edition (#226).
  const resetPassword = async (user: CurrentUser) => {
    const next = await prompt({
      title: `Reset the password for ${user.email}`,
      message: 'They are signed out everywhere and should change it once they are back in. Tell it to them yourself — the panel has no mail server to send it through.',
      label: 'New password',
      confirmLabel: 'Reset password',
      // The API is the real gate; saying so here saves a round trip and tells
      // them which rule they broke while they can still see the field.
      validate: (value) => (value.length >= 8 ? null : 'At least 8 characters'),
    });
    if (next === null) return;
    try {
      await resetUserPassword(user.id, next);
      toast(`${user.email} can sign in with the new password`, 'success', 'Accounts');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not reset that password', 'error', 'Accounts');
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await createUser({ email: email.trim(), password, displayName: displayName.trim() || undefined, platformRole });
      setEmail('');
      setDisplayName('');
      setPassword('');
      setPlatformRole('user');
      toast(`${created.email} can now sign in`, 'success', 'Accounts');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '32px 24px', animation: 'rise 320ms var(--ease-out) both' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: 6 }}>Accounts</h1>
      <p className="subtle" style={{ marginBottom: 24, fontSize: '.88rem' }}>
        Everyone who can sign in to this panel. In the community edition this is the only way in — people
        do not register themselves.
      </p>

      {loadError && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{loadError}</p>}

      <div className="card" style={{ padding: 24, marginBottom: 22 }}>
        <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 16 }}>
          Create an account
          <InfoHint text="The person signs in with this email and password. Tell them to change the password from their Account page once they are in — you will have seen it." label="Create account help" />
        </strong>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="new-email">Email</label>
            <input id="new-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" required />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="new-name">Display name <span className="subtle" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input id="new-name" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ada" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="new-pass">Initial password</label>
            <input id="new-pass" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          <div className="field">
            <span className="field__label">Platform role</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  data-ripple
                  onClick={() => setPlatformRole(r)}
                  className={`opt${platformRole === r ? ' is-active' : ''}`}
                  style={{ textTransform: 'capitalize' }}
                  title={ROLE_HELP[r]}
                >
                  {r}
                </button>
              ))}
            </div>
            <span className="subtle" style={{ display: 'block', marginTop: 8, fontSize: '.82rem' }}>{ROLE_HELP[platformRole]}</span>
          </div>

          {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 16 }}>{error}</p>}

          <button type="submit" className="btn btn--primary" data-ripple data-burst="success" disabled={busy} style={{ minHeight: 42 }}>
            {busy && <span className="spinner" />}
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      </div>

      <strong style={{ display: 'block', fontSize: '.95rem', marginBottom: 12 }}>{users?.length ?? 0} accounts</strong>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {users === null ? (
          <div className="empty">Loading…</div>
        ) : users.length === 0 ? (
          <div className="empty">No accounts to show.</div>
        ) : (
          users.map((u) => (
            <div
              key={u.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}
            >
              <span style={{ flex: 1, minWidth: 160 }}>
                <strong style={{ display: 'block', fontSize: '.9rem' }}>
                  {u.displayName}
                  {u.id === me?.id && <span className="subtle" style={{ fontWeight: 400, fontSize: '.8rem' }}> — you</span>}
                </strong>
                <span className="mono subtle" style={{ fontSize: '.8rem', wordBreak: 'break-all' }}>{u.email}</span>
              </span>
              <span className={`badge${u.platformRole === 'user' ? '' : ' badge--info'}`} style={{ textTransform: 'capitalize' }}>{u.platformRole}</span>
              <span className="subtle" style={{ fontSize: '.8rem', minWidth: 90, textAlign: 'right' }}>{formatRelative(u.createdAt)}</span>
              <button
                className="btn btn--secondary btn--sm"
                data-ripple
                onClick={() => void resetPassword(u)}
                aria-label={`Reset the password for ${u.email}`}
              >
                Reset password
              </button>
            </div>
          ))
        )}
      </div>
      <p className="subtle" style={{ marginTop: 14, fontSize: '.82rem' }}>
        Resetting a password signs that account out everywhere, so it also works as "somebody else is in
        this account". Deleting an account is still separate work.
      </p>
    </div>
  );
}
