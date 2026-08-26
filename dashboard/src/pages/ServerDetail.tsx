import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getDeployment,
  startDeployment,
  stopDeployment,
  restartDeployment,
  deleteDeployment,
  updateDeployment,
  killDeployment,
  streamLogs,
  streamStats,
  execCommand,
  listFiles,
  readFile,
  writeFile,
  uploadFile,
  makeDir,
  renamePath,
  deletePath,
  listDatabases,
  createDatabase,
  deleteDatabase,
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runSchedule,
  listSubusers,
  listDeploymentEvents,
  inviteSubuser,
  updateSubuserRole,
  removeSubuser,
  type DeploymentDetail,
  type DeploymentEvent,
  type FileEntry,
  type ServerDatabase,
  type DatabaseEngine,
  type ServerBackup,
  type ServerSchedule,
  type ScheduleAction,
  listTeams,
  setServerTeam,
  type Team,
  type ServerSubuser,
  type SubuserRole,
} from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';
import { permissionsFor, ROLE_LABELS, type ServerPermission, type ServerRole } from '../permissions';
import { Terminal } from '../components/Terminal';

// Server detail — ported from the redesign, and now backed end to end: header
// actions, live stats, logs, terminal, files, databases, backups, schedules,
// subusers, network and startup all read or drive the real server. Nothing on
// this page invents a value; where data is unavailable it says so (#217, #218,
// #250, #251).
const TABS = ['console', 'terminal', 'files', 'databases', 'backups', 'network', 'schedules', 'subusers', 'startup', 'activity', 'settings'] as const;
type Tab = (typeof TABS)[number];

// Which permission each tab needs (#178). A tab the caller cannot use is hidden
// rather than shown and refused. This mirrors the server-side matrix; the API
// enforces it regardless of what the panel decides to render.
const TAB_PERMISSION: Record<Tab, ServerPermission> = {
  console: 'server.logs',
  terminal: 'console.connect',
  files: 'file.read',
  databases: 'database.manage',
  backups: 'backup.manage',
  network: 'server.view',
  schedules: 'server.view',
  subusers: 'subuser.manage',
  startup: 'server.view',
  activity: 'server.view',
  settings: 'server.delete',
};

export function ServerDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [d, setD] = useState<DeploymentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('console');

  const load = useCallback(async () => {
    try {
      setD(await getDeployment(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [id]);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 3000);
    return () => clearInterval(h);
  }, [load]);

  const act = async (fn: (id: string) => Promise<unknown>, verb: string) => {
    try {
      await fn(id);
      toast(`Deployment ${verb} requested`, 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : `Failed to ${verb}`, 'error');
    }
  };

  // Kill is a force-terminate (SIGKILL), for a container that ignores Stop (#253).
  // It skips the graceful shutdown a server may need, so it asks first.
  const onKill = async () => {
    if (!window.confirm(`Force kill ${d?.name}? The process is terminated immediately and unsaved state is lost. Try Stop first.`)) return;
    await act(killDeployment, 'kill');
  };

  const onDelete = async () => {
    if (!window.confirm(`Delete ${d?.name}? This permanently removes the server and its files. This cannot be undone.`)) return;
    try {
      await deleteDeployment(id);
      toast('Server deleted', 'success', 'Deleted');
      navigate('/servers');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to delete server', 'error');
    }
  };

  if (error) return <div className="page"><p role="alert" className="alert alert--error">{error}</p></div>;
  if (!d) return <div className="page"><div className="empty">Loading…</div></div>;

  const isGame = d.type === 'game' || d.dockerImage.startsWith('nexusinfra/');
  const running = d.status === 'running';
  // What this caller may do here. Absent on older responses, in which case
  // permissionsFor allows everything and the API remains the real gate.
  const allows = permissionsFor(d.role as ServerRole | undefined);
  const visibleTabs = TABS.filter((t) => allows(TAB_PERMISSION[t]));
  // The default tab may not be one this role can open, so fall back to the first
  // that is rather than rendering an empty panel.
  const activeTab = visibleTabs.includes(tab) ? tab : visibleTabs[0];

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 24px 48px', animation: 'rise 300ms var(--ease-out) both' }}>
      <button className="btn btn--ghost btn--sm" data-ripple onClick={() => navigate('/servers')} style={{ marginBottom: 18 }}>
        ← All servers
      </button>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h1 style={{ fontSize: '1.5rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</h1>
            <StatusBadge status={d.status} />
          </div>
          <div className="mono" style={{ marginTop: 5, fontSize: '.85rem', color: 'var(--color-text-subtle)' }}>
            {isGame ? 'game server' : 'application'} · {d.dockerImage}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {running ? (
            <>
              {allows('control.restart') && <button className="btn btn--secondary" data-ripple onClick={() => act(restartDeployment, 'restart')}>Restart</button>}
              {allows('control.stop') && (
                <>
                  <button className="btn btn--danger" data-ripple data-burst="danger" onClick={() => act(stopDeployment, 'stop')}>Stop</button>
                  <button className="btn btn--secondary" data-ripple onClick={onKill}>Kill</button>
                </>
              )}
            </>
          ) : (
            allows('control.start') && <button className="btn btn--secondary" data-ripple data-burst="success" onClick={() => act(startDeployment, 'start')}>Start</button>
          )}
          {/* Say plainly whose server this is when it isn't yours — what you can
              do here follows from that role. */}
          {d.role && d.role !== 'owner' && (
            <span className="subtle" style={{ alignSelf: 'center', fontSize: '.82rem' }} title="Shared with you — what you can do here depends on this role">
              Your role: {ROLE_LABELS[d.role as ServerRole]}
            </span>
          )}
        </div>
      </div>

      {/* Resource stats — real docker stats, or an explicit "unavailable" */}
      <LiveStats id={d.id} running={running} containerId={d.containerId} startedAt={d.startedAt} />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--color-border)', marginBottom: 22 }}>
        {visibleTabs.map((t) => (
          <button key={t} data-ripple onClick={() => setTab(t)} className={`tab${activeTab === t ? ' is-active' : ''}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'console' && <ConsoleTab id={d.id} running={running} containerId={d.containerId} />}
      {activeTab === 'terminal' && <TerminalTab id={d.id} running={running} />}
      {activeTab === 'files' && <FilesTab id={d.id} running={running} />}
      {activeTab === 'databases' && <DatabasesTab id={d.id} running={running} />}
      {activeTab === 'backups' && <BackupsTab id={d.id} running={running} />}
      {activeTab === 'network' && <NetworkTab ports={d.ports ?? {}} />}
      {activeTab === 'schedules' && <SchedulesTab id={d.id} />}
      {activeTab === 'subusers' && <SubusersTab id={d.id} />}
      {activeTab === 'startup' && <StartupTab image={d.dockerImage} env={d.env ?? {}} autoRestart={d.autoRestart ?? false} />}
      {activeTab === 'activity' && <ActivityTab id={d.id} />}
      {activeTab === 'settings' && <SettingsTab deployment={d} allows={allows} onDelete={onDelete} onSaved={load} />}
    </div>
  );
}

/**
 * Header resource stats, streamed from the owning Node Agent's real `docker stats`
 * (#67/#72).
 *
 * These numbers used to be faked in two ways (#250): the meters started at
 * hardcoded values, and a failed stream started a random walk that drifted
 * plausibly forever. An unreachable node therefore looked like a busy, healthy
 * server. Nothing here invents a number now — before the first sample, and after
 * a stream failure, the tiles read `—` and the indicator says why.
 *
 * There is no Disk tile because `docker stats` does not report disk, and no
 * Players/TPS tile because nothing in the stack can measure game telemetry (#252).
 */
function LiveStats({ id, running, containerId, startedAt }: { id: string; running: boolean; containerId: string | null; startedAt: string | null }) {
  const [s, setS] = useState<{ cpu: number; ram: number; netKb: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setS(null);
    setFailed(false);
    if (!running) return;

    const ctrl = new AbortController();
    let cancelled = false;
    // Network counters are cumulative — derive a KB/s rate from consecutive samples.
    let prev: { totalKb: number; t: number } | null = null;

    streamStats(id, (st) => {
      if (cancelled) return;
      const now = Date.now();
      const totalKb = st.rxKb + st.txKb;
      let netKb = 0;
      if (prev && now > prev.t) netKb = Math.max(0, Math.round(((totalKb - prev.totalKb) / (now - prev.t)) * 1000));
      prev = { totalKb, t: now };
      setS({ cpu: Math.round(st.cpuPercent), ram: Math.round(st.memPercent), netKb });
    }, ctrl.signal).catch(() => undefined).finally(() => {
      // Settled either way means no further samples are coming. Keeping the last
      // one on screen would present a frozen number as a live one, which is the
      // same lie in a slower form — so drop it and say the stats are gone.
      if (cancelled) return;
      setS(null);
      setFailed(true);
    });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [id, running, containerId]);

  const mins = running && startedAt ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000) : 0;
  const uptime = running && startedAt ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—';
  const net = s ? (s.netKb >= 1024 ? `${(s.netKb / 1024).toFixed(1)} MB/s` : `${s.netKb} KB/s`) : '—';

  return (
    <div style={{ marginBottom: 24 }}>
      {running && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, fontSize: '.72rem', color: 'var(--color-text-subtle)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: s ? 'var(--color-success)' : 'var(--color-neutral)', animation: s ? 'pulse 1.8s ease-out infinite' : 'none' }} />
            {s ? 'live · docker stats' : failed ? 'stats unavailable — the node agent is not reachable' : 'waiting for the first sample…'}
          </span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
        <StatBox label="CPU" value={s ? `${s.cpu}%` : '—'} />
        <StatBox label="Memory" value={s ? `${s.ram}%` : '—'} />
        <StatBox label="Network" value={net} />
        <StatBox label="Uptime" value={uptime} />
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '13px 16px' }}>
      <div style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-subtle)', marginBottom: 4 }}>{label}</div>
      <div className="tnum" style={{ fontSize: '1.3rem', fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// ── Console — the container's real log stream (#66/#70) + one-shot exec (#68) ─
interface LogLine {
  id: number;
  time: string;
  text: string;
  color: string;
}
const clock = () => {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};
// There were `appLog()` and `gameLog()` generators here that invented plausible
// output — HTTP requests, cache ratios, players joining — whenever the real log
// stream could not be opened, in the same colours as genuine output (#251).
// Someone debugging a broken server was shown a fluent account of events that
// never happened. A stream that fails now says so and stops.

const lineColor = (t: string) =>
  /error|fatal|exit code|oomkilled|panic/i.test(t) ? '#f85149' : /warn|slow|overload|can't keep up/i.test(t) ? '#e3b341' : '#c9d1d9';

// Single-quote a value for safe embedding in the `sh -c` string we build.
const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// Interactive terminal tab (#71): a full xterm.js shell over the exec WebSocket.
// Only meaningful while the server runs; a fresh terminal is mounted per session.
function TerminalTab({ id, running }: { id: string; running: boolean }) {
  if (!running) {
    return <div className="card" style={{ padding: 22 }}><div className="empty">Start the server to open an interactive terminal.</div></div>;
  }
  return (
    <div className="card" style={{ padding: 14 }}>
      <p className="subtle" style={{ margin: '0 0 10px', fontSize: '.82rem' }}>
        A live shell (<code>sh</code>) inside the container. Type <code>exit</code> or leave the tab to end the session.
      </p>
      <Terminal id={id} />
    </div>
  );
}

function ConsoleTab({ id, running, containerId }: { id: string; running: boolean; containerId: string | null }) {
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState('/'); // tracked client-side so cd persists + shows
  const [log, setLog] = useState<LogLine[]>([]);
  const seqRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const append = (text: string, color: string) =>
    setLog((ls) => {
      const next = [...ls, { id: seqRef.current++, time: clock(), text, color }].slice(-200);
      return next;
    });

  // The container's real stdout/stderr. Every line below comes from the server;
  // the panel's own messages are marked so the two can never be confused (#251).
  useEffect(() => {
    setLog([]);
    seqRef.current = 0;
    if (!running) {
      append('— the server is not running, so there is no output to stream —', '#e3b341');
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();

    streamLogs(id, (line) => !cancelled && append(line, lineColor(line)), ctrl.signal)
      .then(() => {
        if (!cancelled) append('— the log stream ended —', '#e3b341');
      })
      .catch(() => {
        if (!cancelled) append('— the log stream is unavailable; the node agent could not be reached —', '#f85149');
      });

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [id, running, containerId]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [log]);

  // Run the command via real `docker exec` (#68). Each call is a fresh `sh -c`, so
  // we prepend `cd <cwd> &&` to make the tracked working directory stick, and treat
  // `cd` specially: run it, then read back `pwd` to update the prompt. A full
  // persistent PTY is #71.
  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    append(`${cwd} $ ${c}`, '#7ee787');
    setCmd('');
    if (!running) {
      append('server is not running', '#e3b341');
      return;
    }
    // A `cd` (alone or with a target): resolve the new directory and update cwd.
    const cdMatch = /^cd(\s+(.*))?$/.exec(c);
    try {
      if (cdMatch) {
        const target = (cdMatch[2] ?? '').trim();
        const r = await execCommand(id, `cd ${shQuote(cwd)} && cd ${target ? shQuote(target) : ''} && pwd`);
        if (r.exitCode === 0) setCwd(r.stdout.trim() || '/');
        else append((r.stderr || `cd: ${target}: no such directory`).replace(/\n$/, ''), '#f85149');
        return;
      }
      const { stdout, stderr, exitCode } = await execCommand(id, `cd ${shQuote(cwd)} && ${c}`);
      const out = (stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')).replace(/\n$/, '');
      if (out) for (const line of out.split('\n')) append(line, exitCode === 0 ? '#c9d1d9' : '#f85149');
      if (exitCode !== 0) append(`exit code ${exitCode}`, '#e3b341');
    } catch (e) {
      append(e instanceof Error ? e.message : 'command failed', '#f85149');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ fontSize: '.92rem' }}>Console</strong>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.76rem', color: 'var(--color-text-subtle)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: running ? 'var(--color-success)' : 'var(--color-neutral)', animation: running ? 'pulse 1.8s ease-out infinite' : 'none' }} />
          {running ? 'streaming' : 'offline'}
        </span>
      </div>
      <div ref={boxRef} style={{ background: '#0a0e16', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '12px 14px', fontFamily: 'var(--font-mono)', fontSize: '.8rem', lineHeight: 1.7, height: 340, overflowY: 'auto' }}>
        {log.map((l) => (
          <div key={l.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            <span style={{ color: '#5a6473' }}>{l.time}</span> <span style={{ color: l.color }}>{l.text}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <span className="mono" title={cwd} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 10px', maxWidth: 220, color: 'var(--color-text-subtle)', border: '1px solid var(--color-border-strong)', borderRight: 'none', borderRadius: 'var(--radius) 0 0 var(--radius)', background: 'var(--color-surface)', fontSize: '.8rem', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl' }}>{cwd}</span>
          <span style={{ color: 'var(--color-primary)' }}>$</span>
        </span>
        <input className="input mono" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} placeholder="run a shell command (ls, ps, cat logs/…) and press Enter" style={{ borderLeft: 'none', borderRadius: 0, fontSize: '.85rem' }} />
        <button className="btn btn--primary" data-ripple onClick={() => void send()} style={{ borderRadius: '0 var(--radius) var(--radius) 0' }}>Send</button>
      </div>
    </>
  );
}

// Shared row/card styles for the option tabs (Files, Databases, Backups, …).
const listCard: CSSProperties = { border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', overflow: 'hidden' };
const rowCss: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', borderBottom: '1px solid var(--color-border)' };

// Human-readable byte size for the file list.
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

// ── Files — real CRUD over the container filesystem (#108) ──────────────────
function FilesTab({ id, running }: { id: string; running: boolean }) {
  const { toast } = useToast();
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (dir: string) => {
      if (!running) return;
      setLoading(true);
      try {
        setEntries(await listFiles(id, dir));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to list files');
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [id, running]
  );

  useEffect(() => {
    void load(cwd);
  }, [load, cwd]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'success', 'Files');
      await load(cwd);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Action failed', 'error', 'Files');
    }
  };

  const open = async (entry: FileEntry) => {
    const path = joinPath(cwd, entry.name);
    if (entry.kind === 'dir') return setCwd(path);
    try {
      const { content } = await readFile(id, path);
      setEditing({ path, content });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Cannot open file', 'error', 'Files');
    }
  };

  const newFolder = () => {
    const name = window.prompt('New folder name');
    if (name?.trim()) void act(() => makeDir(id, joinPath(cwd, name.trim())), `Created ${name.trim()}`);
  };
  const newFile = () => {
    const name = window.prompt('New file name');
    if (name?.trim()) setEditing({ path: joinPath(cwd, name.trim()), content: '' });
  };
  const rename = (entry: FileEntry) => {
    const name = window.prompt('Rename to', entry.name);
    if (name?.trim() && name.trim() !== entry.name) void act(() => renamePath(id, joinPath(cwd, entry.name), joinPath(cwd, name.trim())), 'Renamed');
  };
  const remove = (entry: FileEntry) => {
    if (window.confirm(`Delete ${entry.name}? This cannot be undone.`)) void act(() => deletePath(id, joinPath(cwd, entry.name)), `Deleted ${entry.name}`);
  };
  // Raw bytes, not text (#263): decoding an upload and re-encoding it corrupts
  // anything that is not UTF-8 — which is most of what people upload here.
  const onUpload = async (file: File) => {
    void act(() => uploadFile(id, joinPath(cwd, file.name), file), `Uploaded ${file.name}`);
  };

  const crumbs = cwd === '/' ? [] : cwd.slice(1).split('/');

  if (!running) return <div className="empty">Start the server to browse its files.</div>;

  if (editing) return <FileEditor id={id} file={editing} onClose={() => setEditing(null)} onSaved={() => load(cwd)} />;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', fontSize: '.88rem' }}>
          <button className="name-btn" onClick={() => setCwd('/')}>container</button>
          <span className="subtle">/</span>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button className="name-btn" onClick={() => setCwd('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              <span className="subtle">/</span>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--secondary btn--sm" data-ripple onClick={newFile}>New file</button>
          <button className="btn btn--secondary btn--sm" data-ripple onClick={newFolder}>New folder</button>
          <button className="btn btn--primary btn--sm" data-ripple data-magnetic onClick={() => fileInput.current?.click()}>Upload</button>
          <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); e.target.value = ''; }} />
        </div>
      </div>
      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}
      <div style={listCard}>
        {entries.map((entry) => (
          <div key={entry.name} style={{ ...rowCss, gap: 10 }}>
            <button
              data-ripple
              onClick={() => void open(entry)}
              style={{ ...rowCss, flex: 1, minWidth: 0, padding: 0, border: 'none', borderBottom: 'none', background: 'transparent', color: 'var(--color-text)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
            >
              <span style={{ flex: 'none' }}>{entry.kind === 'dir' ? '📁' : '📄'}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: '.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: entry.kind === 'dir' ? 'var(--color-primary)' : 'var(--color-text)', fontWeight: entry.kind === 'dir' ? 600 : 400 }}>{entry.name}</span>
              {entry.kind === 'file' && <span className="subtle tnum" style={{ fontSize: '.8rem' }}>{fmtSize(entry.size)}</span>}
            </button>
            <button className="icon-btn" data-ripple aria-label={`Rename ${entry.name}`} onClick={() => rename(entry)}>✎</button>
            <button className="icon-btn" data-ripple aria-label={`Delete ${entry.name}`} onClick={() => remove(entry)}>🗑</button>
          </div>
        ))}
        {!loading && entries.length === 0 && !error && <div className="empty">This folder is empty.</div>}
        {loading && <div className="empty">Loading…</div>}
      </div>
    </>
  );
}

function FileEditor({ id, file, onClose, onSaved }: { id: string; file: { path: string; content: string }; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState(file.content);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await writeFile(id, file.path, text);
      toast('Saved', 'success', 'Files');
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error', 'Files');
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 12 }}>
        <button className="btn btn--ghost btn--sm" data-ripple onClick={onClose}>← Back to files</button>
        <span className="mono subtle" style={{ fontSize: '.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.path}</span>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="success" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      <textarea
        className="input mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="File contents"
        spellCheck={false}
        style={{ width: '100%', height: 380, background: '#0a0e16', color: '#c9d1d9', fontSize: '.82rem', lineHeight: 1.6, resize: 'vertical' }}
      />
    </>
  );
}

// ── Databases — real per-server engine containers (#109) ────────────────────
const DB_ENGINES: DatabaseEngine[] = ['mysql', 'mariadb', 'postgres'];

function DatabasesTab({ id, running }: { id: string; running: boolean }) {
  const { toast } = useToast();
  const [dbs, setDbs] = useState<ServerDatabase[]>([]);
  const [engine, setEngine] = useState<DatabaseEngine>('mysql');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDbs(await listDatabases(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load databases');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const db = await createDatabase(id, engine);
      toast(`Database ${db.name} provisioned`, 'success', 'Database');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Provisioning failed', 'error', 'Database');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (db: ServerDatabase) => {
    if (!window.confirm(`Delete database ${db.name}? This destroys its data.`)) return;
    try {
      await deleteDatabase(id, db.id);
      toast('Database deleted', 'error', 'Database');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error', 'Database');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '.92rem' }}>Databases<InfoHint text="Each database is its own engine container with generated credentials. MySQL/MariaDB are interchangeable SQL engines; Postgres is a more advanced SQL engine. Pick one, then connect with the host, port and password shown." label="Databases help" /></strong>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {DB_ENGINES.map((e) => (
              <button key={e} type="button" data-ripple onClick={() => setEngine(e)} className={`opt${engine === e ? ' is-active' : ''}`} style={{ textTransform: 'capitalize' }}>
                {e}
              </button>
            ))}
          </div>
          <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={create} disabled={busy || !running} title={running ? '' : 'Start the server first'}>
            {busy ? 'Provisioning…' : 'New database'}
          </button>
        </div>
      </div>
      {!running && <p className="subtle" style={{ fontSize: '.84rem', marginBottom: 12 }}>Start the server to provision a database.</p>}
      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}
      <div style={listCard}>
        {dbs.map((db) => (
          <div key={db.id} style={{ ...rowCss, gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{ fontSize: '.86rem', fontWeight: 600 }}>{db.name} <span className="badge badge--info" style={{ marginLeft: 6 }}>{db.engine}</span></div>
              <div className="mono subtle" style={{ fontSize: '.78rem', marginTop: 3, wordBreak: 'break-all' }}>
                {db.username}@{db.host}:{db.port} · pw {db.password}
              </div>
            </div>
            <button className="icon-btn" data-ripple aria-label={`Delete ${db.name}`} onClick={() => remove(db)}>🗑</button>
          </div>
        ))}
        {dbs.length === 0 && <div className="empty">No databases yet.</div>}
      </div>
    </>
  );
}

// ── Backups — real tar snapshots of the server's data volume (#110) ─────────
function BackupsTab({ id, running }: { id: string; running: boolean }) {
  const { toast } = useToast();
  const [backups, setBackups] = useState<ServerBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBackups(await listBackups(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load backups');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const b = await createBackup(id);
      toast(`Backup ${b.name} created`, 'success', 'Backup');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Backup failed', 'error', 'Backup');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (b: ServerBackup) => {
    if (!window.confirm(`Restore ${b.name}? This overwrites ${b.path} in the running server.`)) return;
    try {
      await restoreBackup(id, b.id);
      toast(`Restored ${b.name}`, 'success', 'Backup');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Restore failed', 'error', 'Backup');
    }
  };

  const remove = async (b: ServerBackup) => {
    if (!window.confirm(`Delete ${b.name}? This cannot be undone.`)) return;
    try {
      await deleteBackup(id, b.id);
      toast('Backup deleted', 'error', 'Backup');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error', 'Backup');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
        <strong style={{ fontSize: '.92rem' }}>Backups<InfoHint text="A backup is a tar snapshot of the server's data directory, stored on its node. Restore extracts it back into the running container. Requires the server to be running." label="Backups help" /></strong>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={create} disabled={busy || !running} title={running ? '' : 'Start the server first'}>
          {busy ? 'Snapshotting…' : 'Create backup'}
        </button>
      </div>
      {!running && <p className="subtle" style={{ fontSize: '.84rem', marginBottom: 12 }}>Start the server to snapshot or restore its data.</p>}
      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}
      <div style={listCard}>
        {backups.map((b) => (
          <div key={b.id} style={{ ...rowCss, gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{ fontSize: '.84rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
              <div className="subtle" style={{ fontSize: '.76rem', marginTop: 2 }}>{fmtSize(b.sizeBytes)} · <span className="mono">{b.path}</span></div>
            </div>
            <button className="btn btn--secondary btn--sm" data-ripple onClick={() => restore(b)} disabled={!running}>Restore</button>
            <button className="icon-btn" data-ripple aria-label={`Delete ${b.name}`} onClick={() => remove(b)}>🗑</button>
          </div>
        ))}
        {backups.length === 0 && <div className="empty">No backups yet.</div>}
      </div>
    </>
  );
}

// The server's real port mappings, as configured at creation and carried on the
// detail response (#217). This used to render two invented allocations and an
// SFTP endpoint nothing in the stack listens on; real SFTP is its own work (#235).
function NetworkTab({ ports }: { ports: Record<string, string> }) {
  const allocs = Object.entries(ports);
  return (
    <>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>
        Port allocations
        <InfoHint text="Each row maps a port on the node to a port inside the container. Reach the server on the node's address and the host port." label="Port allocations help" />
      </strong>
      {allocs.length === 0 ? (
        <div className="card" style={{ padding: '20px 22px' }}>
          <p className="subtle" style={{ margin: 0, fontSize: '.86rem' }}>
            This server has no published ports — nothing on the node's network reaches it.
          </p>
        </div>
      ) : (
        <div style={listCard}>
          {allocs.map(([hostPort, containerPort]) => (
            <div key={hostPort} style={rowCss}>
              <span className="mono" style={{ flex: 'none', minWidth: 90, fontSize: '.86rem', fontWeight: 600 }}>{hostPort}</span>
              <span className="muted" style={{ fontSize: '.84rem' }}>on the node →</span>
              <span className="mono" style={{ flex: 1, fontSize: '.86rem' }}>{containerPort}</span>
              <span className="muted" style={{ fontSize: '.84rem' }}>in the container</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Activity — the server's audit trail (#223) ──────────────────────────────
// Every lifecycle change has written a DeploymentEvent since the beginning; this
// is the first thing that reads them back.
const PAGE = 50;

function ActivityTab({ id }: { id: string }) {
  const [events, setEvents] = useState<DeploymentEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadMore = useCallback(
    async (offset: number) => {
      setBusy(true);
      try {
        const page = await listDeploymentEvents(id, { limit: PAGE, offset });
        setEvents((prev) => (offset === 0 ? page : [...(prev ?? []), ...page]));
        setDone(page.length < PAGE);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load the activity trail');
      } finally {
        setBusy(false);
      }
    },
    [id]
  );

  useEffect(() => {
    void loadMore(0);
  }, [loadMore]);

  return (
    <>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>
        Activity
        <InfoHint text="Everything that has happened to this server, newest first: creation, placement, start and stop requests, crashes and restores. Recorded by the orchestrator, not by the container." label="Activity help" />
      </strong>
      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}
      {events === null ? (
        <div className="card" style={{ padding: 22 }}><div className="empty">Loading…</div></div>
      ) : events.length === 0 ? (
        <div className="card" style={{ padding: 22 }}><div className="empty">Nothing has happened to this server yet.</div></div>
      ) : (
        <>
          <div style={listCard}>
            {events.map((e) => (
              <div key={e.id} style={{ ...rowCss, gap: 12, alignItems: 'flex-start' }}>
                <span className="badge" style={{ flex: 'none', minWidth: 128 }}>{e.event}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: '.86rem', wordBreak: 'break-word' }}>{e.message}</span>
                <span className="subtle mono" style={{ flex: 'none', fontSize: '.78rem' }} title={e.timestamp}>
                  {new Date(e.timestamp).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          {!done && (
            <button className="btn btn--secondary btn--sm" data-ripple disabled={busy} style={{ marginTop: 12 }} onClick={() => void loadMore(events.length)}>
              {busy ? 'Loading…' : 'Load older'}
            </button>
          )}
        </>
      )}
    </>
  );
}

// ── Schedules — real cron tasks run by the orchestrator (#111) ──────────────
function SchedulesTab({ id }: { id: string }) {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<ServerSchedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 4 * * *');
  const [action, setAction] = useState<ScheduleAction>('backup');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSchedules(await listSchedules(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schedules');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) return toast('Give the schedule a name', 'error', 'Schedule');
    setBusy(true);
    try {
      await createSchedule(id, { name: name.trim(), cron: cron.trim(), action });
      toast('Schedule created', 'success', 'Schedule');
      setName('');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Create failed', 'error', 'Schedule');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: ServerSchedule) => {
    try {
      await updateSchedule(id, s.id, { enabled: !s.enabled });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', 'error', 'Schedule');
    }
  };
  const runNow = async (s: ServerSchedule) => {
    try {
      await runSchedule(id, s.id);
      toast(`Ran “${s.name}”`, 'success', 'Schedule');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Run failed', 'error', 'Schedule');
    }
  };
  const remove = async (s: ServerSchedule) => {
    try {
      await deleteSchedule(id, s.id);
      toast('Schedule deleted', 'error', 'Schedule');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error', 'Schedule');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <strong style={{ fontSize: '.92rem' }}>Schedules<InfoHint text="Recurring tasks the orchestrator runs on a 5-field cron (minute hour day-of-month month day-of-week, UTC). Actions: restart the server, or snapshot a backup." label="Schedules help" /></strong>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 140px', minWidth: 0 }}>
          <span className="field__label" style={{ fontSize: '.78rem' }}>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly backup" />
        </label>
        <label style={{ flex: '1 1 120px', minWidth: 0 }}>
          <span className="field__label" style={{ fontSize: '.78rem' }}>Cron (UTC)</span>
          <input className="input mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 4 * * *" />
        </label>
        <div>
          <span className="field__label" style={{ fontSize: '.78rem' }}>Action</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['backup', 'restart'] as ScheduleAction[]).map((a) => (
              <button key={a} type="button" data-ripple onClick={() => setAction(a)} className={`opt${action === a ? ' is-active' : ''}`} style={{ textTransform: 'capitalize' }}>{a}</button>
            ))}
          </div>
        </div>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={create} disabled={busy} style={{ minHeight: 40 }}>New schedule</button>
      </div>

      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}
      <div className="stack">
        {schedules.map((s) => (
          <div key={s.id} style={{ ...rowCss, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
                <strong style={{ fontSize: '.9rem' }}>{s.name}</strong>
                <span style={{ fontSize: '.72rem', fontWeight: 600, color: s.enabled ? 'var(--color-success)' : 'var(--color-text-subtle)' }}>{s.enabled ? 'active' : 'paused'}</span>
              </div>
              <div className="subtle" style={{ fontSize: '.8rem' }}>
                <span className="mono muted">{s.cron}</span> · {s.action}{s.lastRunAt ? ` · last run ${new Date(s.lastRunAt).toLocaleString()}` : ''}
              </div>
            </div>
            <button className="btn btn--secondary btn--sm" data-ripple onClick={() => runNow(s)}>Run now</button>
            <button role="switch" aria-checked={s.enabled} aria-label={`Toggle ${s.name}`} onClick={() => toggle(s)} style={{ flex: 'none', width: 44, height: 26, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer', padding: 3, transition: 'background 200ms', background: s.enabled ? 'var(--color-primary)' : 'var(--color-border-strong)' }}>
              <span style={{ display: 'block', width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'transform 200ms var(--ease-out)', transform: s.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
            </button>
            <button className="icon-btn" data-ripple aria-label={`Delete ${s.name}`} onClick={() => remove(s)}>🗑</button>
          </div>
        ))}
        {schedules.length === 0 && <div className="empty">No schedules yet.</div>}
      </div>
    </>
  );
}

// ── Subusers — real per-server access control (#112) ────────────────────────
const ROLE_COLOR: Record<string, { soft: string; color: string }> = {
  admin: { soft: 'var(--color-success-soft)', color: 'var(--color-success)' },
  operator: { soft: 'var(--color-primary-soft)', color: 'var(--color-primary)' },
  viewer: { soft: 'var(--color-neutral-soft)', color: 'var(--color-neutral)' },
};

// What each role actually means, shown under the address so the choice is not a
// guess. Mirrors the server-side matrix in access.ts.
const ROLE_SUMMARY: Record<string, string> = {
  admin: 'Manage the server — everything but deleting it',
  operator: 'Start, stop, restart and use the console',
  viewer: 'Read-only — status, logs and usage',
};

function SubusersTab({ id }: { id: string }) {
  const { toast } = useToast();
  const [users, setUsers] = useState<ServerSubuser[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SubuserRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await listSubusers(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load subusers');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async () => {
    setBusy(true);
    try {
      await inviteSubuser(id, email.trim(), role);
      toast(`Invited ${email.trim()}`, 'success', 'Subuser');
      setEmail('');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Invite failed', 'error', 'Subuser');
    } finally {
      setBusy(false);
    }
  };
  const changeRole = async (u: ServerSubuser, r: SubuserRole) => {
    try {
      await updateSubuserRole(id, u.id, r);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', 'error', 'Subuser');
    }
  };
  const revoke = async (u: ServerSubuser) => {
    if (!window.confirm(`Revoke access for ${u.email}?`)) return;
    try {
      await removeSubuser(id, u.id);
      toast('Access revoked', 'error', 'Subuser');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Revoke failed', 'error', 'Subuser');
    }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <strong style={{ fontSize: '.92rem' }}>Subusers<InfoHint text="Grant other people access to this server by email. Viewer sees status and logs; operator can also start, stop and restart it; admin can manage everything except deleting it. Access is enforced on every request, so revoking takes effect at once. Inviting someone who has no account yet leaves the invitation pending — it grants nothing until they sign up with that address." label="Subusers help" /></strong>
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 200px', minWidth: 0 }}>
          <span className="field__label" style={{ fontSize: '.78rem' }}>Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" onKeyDown={(e) => e.key === 'Enter' && void invite()} />
        </label>
        <div>
          <span className="field__label" style={{ fontSize: '.78rem' }}>Role</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['viewer', 'operator', 'admin'] as SubuserRole[]).map((r) => (
              <button key={r} type="button" data-ripple onClick={() => setRole(r)} className={`opt${role === r ? ' is-active' : ''}`} style={{ textTransform: 'capitalize' }}>{r}</button>
            ))}
          </div>
        </div>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={invite} disabled={busy} style={{ minHeight: 40 }}>Invite user</button>
      </div>

      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 12 }}>{error}</p>}
      <div style={listCard}>
        {users.map((u) => {
          const rc = ROLE_COLOR[u.role] ?? ROLE_COLOR.viewer;
          return (
            <div key={u.id} style={rowCss}>
              <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: '50%', background: 'var(--color-primary-soft)', color: 'var(--color-primary)', fontWeight: 700, fontSize: '.85rem' }}>{u.email[0]?.toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '.88rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                <div className="subtle" style={{ fontSize: '.78rem' }}>
                  {u.status === 'pending' && (
                    <span title="Invited, but they have not signed up yet — this grants no access until they do" style={{ color: 'var(--color-warning)', fontWeight: 600 }}>Pending · </span>
                  )}
                  {ROLE_SUMMARY[u.role] ?? u.role}
                </div>
              </div>
              <select className="select" value={u.role} onChange={(e) => void changeRole(u, e.target.value as SubuserRole)} aria-label={`Role for ${u.email}`} style={{ width: 'auto', minHeight: 32, padding: '0 8px', fontSize: '.78rem', color: rc.color, background: rc.soft, borderColor: rc.soft }}>
                <option value="viewer">viewer</option>
                <option value="operator">operator</option>
                <option value="admin">admin</option>
              </select>
              <button className="icon-btn" data-ripple aria-label={`Revoke ${u.email}`} onClick={() => revoke(u)}>✕</button>
            </div>
          );
        })}
        {users.length === 0 && <div className="empty">No subusers yet — you have full access as the owner.</div>}
      </div>
    </>
  );
}

// What this server actually runs (#218): its image, its restart policy and its own
// environment. It used to render three invented variables (EULA, MAX_MEMORY, …)
// and a startup command nothing executes. Editing these is #220.
function StartupTab({ image, env, autoRestart }: { image: string; env: Record<string, string>; autoRestart: boolean }) {
  const vars = Object.entries(env);
  return (
    <>
      <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>Container image</strong>
        <div className="mono" style={{ fontSize: '.84rem', background: '#0a0e16', color: '#c9d1d9', padding: '12px 14px', borderRadius: 'var(--radius)', wordBreak: 'break-all' }}>
          {image}
        </div>
        <p className="subtle" style={{ margin: '12px 0 0', fontSize: '.84rem' }}>
          The image runs its own entrypoint; the variables below are what NexusInfra passes in.
          Restart on failure is <strong>{autoRestart ? 'on' : 'off'}</strong>.
        </p>
      </div>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>
        Environment variables
        <InfoHint text="Passed to the container at start. Changing them takes effect the next time the server starts." label="Environment variables help" />
      </strong>
      {vars.length === 0 ? (
        <div className="card" style={{ padding: '20px 22px' }}>
          <p className="subtle" style={{ margin: 0, fontSize: '.86rem' }}>
            No environment variables are set for this server.
          </p>
        </div>
      ) : (
        <div style={listCard}>
          {vars.map(([key, value]) => (
            <div key={key} style={rowCss}>
              <span className="mono" style={{ flex: 'none', minWidth: 160, fontSize: '.84rem', fontWeight: 600 }}>{key}</span>
              <span className="mono muted" style={{ fontSize: '.84rem', wordBreak: 'break-all' }}>{value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Change a server's configuration after creation (#220). Until this existed the
 * config was frozen: correcting a typo in a name meant deleting the server, and
 * its databases, backups, schedules and subusers went with it.
 *
 * Nothing here restarts the container. A settings form that silently bounced
 * someone's running server would be a worse surprise than one that waits, so the
 * change is stored and applied the next time it starts — and the form says so.
 */
function ConfigEditor({ deployment, onSaved }: { deployment: DeploymentDetail; onSaved: () => Promise<void> | void }) {
  const { toast } = useToast();
  const [name, setName] = useState(deployment.name);
  const [image, setImage] = useState(deployment.dockerImage);
  const [ports, setPorts] = useState(() => JSON.stringify(deployment.ports ?? {}, null, 2));
  const [env, setEnv] = useState(() => JSON.stringify(deployment.env ?? {}, null, 2));
  const [autoRestart, setAutoRestart] = useState(Boolean(deployment.autoRestart));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parseMap = (text: string, label: string): Record<string, string> => {
    const value: unknown = JSON.parse(text || '{}');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  };

  const save = async () => {
    setError(null);
    let parsedPorts: Record<string, string>;
    let parsedEnv: Record<string, string>;
    try {
      parsedPorts = parseMap(ports, 'Ports');
      parsedEnv = parseMap(env, 'Environment');
    } catch (e) {
      return setError(e instanceof Error ? e.message : 'Ports and environment must be JSON objects');
    }
    if (!name.trim()) return setError('A name is required');
    if (!image.trim()) return setError('An image is required');

    setBusy(true);
    try {
      await updateDeployment(deployment.id, {
        name: name.trim(),
        dockerImage: image.trim(),
        ports: parsedPorts,
        env: parsedEnv,
        autoRestart,
      });
      toast('Configuration saved — it applies the next time this server starts', 'success', 'Settings');
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the configuration');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6 }}>
        Server configuration
        <InfoHint text="Name, image, published ports and environment. Saving stores the change; the running container is left alone and picks it up the next time the server starts." label="Server configuration help" />
      </strong>
      <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>
        Changes take effect the next time this server starts — nothing is restarted for you.
      </p>

      <div className="field">
        <label className="field__label" htmlFor="cfg-name">Name</label>
        <input id="cfg-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="cfg-image">Docker image</label>
        <input id="cfg-image" className="input mono" value={image} onChange={(e) => setImage(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="cfg-ports">Ports <span className="subtle" style={{ fontWeight: 400 }}>(host : container, as JSON)</span></label>
        <textarea id="cfg-ports" className="input mono" rows={3} value={ports} onChange={(e) => setPorts(e.target.value)} style={{ resize: 'vertical' }} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="cfg-env">Environment <span className="subtle" style={{ fontWeight: 400 }}>(as JSON)</span></label>
        <textarea id="cfg-env" className="input mono" rows={4} value={env} onChange={(e) => setEnv(e.target.value)} style={{ resize: 'vertical' }} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, fontSize: '.86rem' }}>
        <input type="checkbox" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} />
        Restart automatically if it stops unexpectedly
      </label>

      {error && <p role="alert" className="alert alert--error" style={{ marginBottom: 14 }}>{error}</p>}

      <button className="btn btn--primary btn--sm" data-ripple data-burst="success" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save configuration'}
      </button>
    </div>
  );
}

function SettingsTab({
  deployment,
  allows,
  onDelete,
  onSaved,
}: {
  deployment: DeploymentDetail;
  allows: (p: ServerPermission) => boolean;
  onDelete: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const id = deployment.id;
  const teamId = deployment.teamId ?? null;
  const [teams, setTeams] = useState<Team[]>([]);
  const [team, setTeam] = useState<string>(teamId ?? '');

  // Which teams this server can be shared with — only ones the caller is in, so
  // a server can't be pushed onto strangers (the API enforces the same rule).
  useEffect(() => {
    void listTeams().then(setTeams).catch(() => undefined);
  }, []);

  const share = async (next: string) => {
    setTeam(next);
    try {
      await setServerTeam(id, next || null);
      toast(next ? 'Server shared with the team' : 'Server no longer shared with a team', 'success', 'Teams');
    } catch (e) {
      setTeam(teamId ?? '');
      toast(e instanceof Error ? e.message : 'Could not change the team', 'error', 'Teams');
    }
  };

  return (
    <>
      {allows('server.edit') && <ConfigEditor deployment={deployment} onSaved={onSaved} />}
      <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6 }}>
          Share with a team
          <InfoHint text="Everyone in the team gets their team role on this server, without being invited to it individually. The server stays yours — detaching it, or deleting the team, only removes the sharing." label="Team sharing help" />
        </strong>
        <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>
          {teams.length ? 'Only teams you belong to are listed.' : 'You are not in any team yet — create one on the Teams page.'}
        </p>
        <select className="select" value={team} onChange={(e) => void share(e.target.value)} aria-label="Team for this server" disabled={!teams.length} style={{ width: 'auto', minWidth: 220 }}>
          <option value="">Not shared with a team</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      {/*
        A "Reinstall" card used to sit here, wired to a 'Not wired yet' toast. It
        was never implementable as written: there is no install script to re-run,
        and Start already recreates the container from the saved config, so
        reinstalling would be stop + start under a different name (#219). It comes
        back when there is something distinct to do — pulling a fresh image (#239)
        or rebuilding from a template (#231).
      */}
      <div className="card" style={{ padding: '20px 22px', borderColor: 'var(--color-danger-soft)' }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6, color: 'var(--color-danger)' }}>Delete server</strong>
        <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>Permanently removes this server and all of its files. This cannot be undone.</p>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="danger" onClick={onDelete} style={{ background: 'var(--color-danger)' }}>Delete server</button>
      </div>
    </>
  );
}
