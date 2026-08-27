import { useCallback, useEffect, useState } from 'react';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getCurrentUser,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeamMemberRole,
  type CurrentUser,
  type SubuserRole,
  type Team,
  type TeamDetail,
} from '../api';
import { InfoHint } from '../components/InfoHint';
import { useToast } from '../components/Toast';
import { useDialog } from '../components/Dialog';

// Teams (#177) — sharing at the level of a group rather than one server at a
// time. The server-side rules this page reflects: only the team owner may change
// membership, anyone may leave, and deleting a team detaches its servers instead
// of deleting them.

const ROLES: SubuserRole[] = ['viewer', 'operator', 'admin'];

const ROLE_SUMMARY: Record<string, string> = {
  admin: 'Manage every team server — everything but deleting one',
  operator: 'Start, stop, restart and use the console',
  viewer: 'Read-only — status, logs and usage',
};

export function Teams() {
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState<TeamDetail | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SubuserRole>('operator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      const list = await listTeams();
      setTeams(list);
      setError(null);
      return list;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load teams');
      return [];
    }
  }, []);

  const openTeam = useCallback(async (id: string) => {
    try {
      setSelected(await getTeam(id));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to open team', 'error', 'Teams');
    }
  }, [toast]);

  useEffect(() => {
    void getCurrentUser().then(setMe).catch(() => undefined);
    void loadTeams().then((list) => {
      if (list.length) void openTeam(list[0].id);
    });
  }, [loadTeams, openTeam]);

  const isOwner = !!selected && !!me && selected.ownerId === me.id;

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const team = await createTeam(name.trim());
      toast(`Team "${team.name}" created`, 'success', 'Teams');
      setName('');
      await loadTeams();
      await openTeam(team.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the team', 'error', 'Teams');
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    if (!selected || !email.trim()) return;
    setBusy(true);
    try {
      await addTeamMember(selected.id, email.trim(), role);
      toast(`${email.trim()} added to ${selected.name}`, 'success', 'Teams');
      setEmail('');
      await openTeam(selected.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add that person', 'error', 'Teams');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (userId: string, r: SubuserRole) => {
    if (!selected) return;
    try {
      await updateTeamMemberRole(selected.id, userId, r);
      await openTeam(selected.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the role', 'error', 'Teams');
    }
  };

  const remove = async (userId: string, label: string) => {
    if (!selected) return;
    const leaving = userId === me?.id;
    const ok = await confirm({
      title: leaving ? `Leave ${selected.name}?` : `Remove ${label} from ${selected.name}?`,
      message: leaving
        ? 'You lose access to every server shared with this team. The owner can add you back.'
        : 'They lose access to every server shared with this team. Anything shared with them directly is untouched.',
      confirmLabel: leaving ? 'Leave' : 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeTeamMember(selected.id, userId);
      toast(leaving ? `You left ${selected.name}` : `${label} removed`, 'error', 'Teams');
      if (leaving) {
        setSelected(null);
        await loadTeams();
      } else {
        await openTeam(selected.id);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove that person', 'error', 'Teams');
    }
  };

  const destroy = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: `Delete the team “${selected.name}”?`,
      message: 'Its servers stay where they are — they are simply no longer shared with the team, and everyone in it loses the access it granted.',
      confirmLabel: 'Delete team',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTeam(selected.id);
      toast(`Team "${selected.name}" deleted`, 'error', 'Teams');
      setSelected(null);
      const list = await loadTeams();
      if (list.length) await openTeam(list[0].id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the team', 'error', 'Teams');
    }
  };

  return (
    <section>
      <header style={{ marginBottom: 18 }}>
        <h1>
          Teams
          <InfoHint
            text="A team shares every server attached to it with everyone in it, so you don't have to invite each person to each server. Servers stay owned by whoever created them — attach one to a team from its Settings tab. Deleting a team never deletes servers."
            label="Teams help"
          />
        </h1>
        <p className="subtle">Share servers with a group instead of one person at a time.</p>
      </header>

      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="card" style={{ padding: 14, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 220px', minWidth: 0 }}>
          <span className="field__label" style={{ fontSize: '.78rem' }}>New team name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Platform" onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </label>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={create} disabled={busy || !name.trim()} style={{ minHeight: 40 }}>
          Create team
        </button>
      </div>

      {teams.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {teams.map((t) => (
            <button key={t.id} type="button" data-ripple onClick={() => void openTeam(t.id)} className={`opt${selected?.id === t.id ? ' is-active' : ''}`}>
              {t.name}
            </button>
          ))}
        </div>
      )}

      {teams.length === 0 && <div className="empty">No teams yet — create one to share servers with a group.</div>}

      {selected && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <strong style={{ fontSize: '.92rem' }}>{selected.name}</strong>
            {isOwner ? (
              <span className="subtle" style={{ fontSize: '.78rem' }}>You own this team</span>
            ) : (
              <span className="subtle" style={{ fontSize: '.78rem' }}>You are a member</span>
            )}
            <span style={{ flex: 1 }} />
            {isOwner && (
              <button className="btn btn--ghost btn--sm" data-ripple onClick={destroy}>
                Delete team
              </button>
            )}
          </div>

          {/* Only the owner can change who is in the team; the API enforces this
              too, so hiding the form is a convenience, not the control. */}
          {isOwner && (
            <div className="card" style={{ padding: 14, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ flex: '1 1 200px', minWidth: 0 }}>
                <span className="field__label" style={{ fontSize: '.78rem' }}>
                  Email
                  <InfoHint text="They need an account already — a team grants access to every server it holds, so it isn't left waiting on an address nobody has signed up with." label="Member email help" />
                </span>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" onKeyDown={(e) => e.key === 'Enter' && void invite()} />
              </label>
              <div>
                <span className="field__label" style={{ fontSize: '.78rem' }}>Role</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {ROLES.map((r) => (
                    <button key={r} type="button" data-ripple onClick={() => setRole(r)} className={`opt${role === r ? ' is-active' : ''}`} style={{ textTransform: 'capitalize' }}>
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={invite} disabled={busy || !email.trim()} style={{ minHeight: 40 }}>
                Add member
              </button>
            </div>
          )}

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {selected.members.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--color-border)' }}>
                <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: '50%', background: 'var(--color-primary-soft)', color: 'var(--color-primary)', fontWeight: 700, fontSize: '.85rem' }}>
                  {(m.displayName || m.email)[0]?.toUpperCase()}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '.88rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.displayName}
                    {m.userId === me?.id && <span className="subtle" style={{ fontWeight: 400 }}> (you)</span>}
                  </div>
                  <div className="subtle" style={{ fontSize: '.78rem' }}>{ROLE_SUMMARY[m.role] ?? m.role}</div>
                </div>
                {isOwner ? (
                  <select className="select" value={m.role} onChange={(e) => void changeRole(m.userId, e.target.value as SubuserRole)} aria-label={`Role for ${m.displayName}`} style={{ width: 'auto', minHeight: 32, padding: '0 8px', fontSize: '.78rem' }}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                ) : (
                  <span className="subtle" style={{ fontSize: '.78rem' }}>{m.role}</span>
                )}
                {(isOwner || m.userId === me?.id) && (
                  <button className="icon-btn" data-ripple aria-label={m.userId === me?.id ? 'Leave this team' : `Remove ${m.displayName}`} onClick={() => void remove(m.userId, m.displayName)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {selected.members.length === 0 && <div className="empty">Just you so far — add someone by email.</div>}
          </div>
        </>
      )}
    </section>
  );
}
