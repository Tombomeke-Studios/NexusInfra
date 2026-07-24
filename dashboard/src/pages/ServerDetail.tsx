import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getDeployment,
  startDeployment,
  stopDeployment,
  restartDeployment,
  streamLogs,
  streamStats,
  listFiles,
  readFile,
  writeFile,
  makeDir,
  renamePath,
  deletePath,
  listDatabases,
  createDatabase,
  deleteDatabase,
  type DeploymentDetail,
  type FileEntry,
  type ServerDatabase,
  type DatabaseEngine,
} from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { InfoHint } from '../components/InfoHint';
import { getDeploymentDefaults } from '../prefs';

// Server detail — ported from the redesign. The header/status/actions are real;
// the resource stats and every tab's content are UI/mock for now and get wired
// up later (console → #66–#72, files/databases/backups/etc. → their own work).
const TABS = ['console', 'files', 'databases', 'backups', 'network', 'schedules', 'subusers', 'startup', 'settings'] as const;
type Tab = (typeof TABS)[number];

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

  if (error) return <div className="page"><p role="alert" className="alert alert--error">{error}</p></div>;
  if (!d) return <div className="page"><div className="empty">Loading…</div></div>;

  const isGame = d.dockerImage.startsWith('nexusinfra/');
  const running = d.status === 'running';

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
            {isGame ? d.dockerImage.replace('nexusinfra/', '') : 'application'} · {d.dockerImage}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {running ? (
            <>
              <button className="btn btn--secondary" data-ripple onClick={() => act(restartDeployment, 'restart')}>Restart</button>
              <button className="btn btn--danger" data-ripple data-burst="danger" onClick={() => act(stopDeployment, 'stop')}>Stop</button>
              <button className="btn btn--secondary" data-ripple onClick={() => toast('Kill is not wired yet', 'info')}>Kill</button>
            </>
          ) : (
            <button className="btn btn--secondary" data-ripple data-burst="success" onClick={() => act(startDeployment, 'start')}>Start</button>
          )}
        </div>
      </div>

      {/* Resource stats — real docker stats while running, mock fallback */}
      <LiveStats id={d.id} running={running} isGame={isGame} containerId={d.containerId} startedAt={d.startedAt} />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--color-border)', marginBottom: 22 }}>
        {TABS.map((t) => (
          <button key={t} data-ripple onClick={() => setTab(t)} className={`tab${tab === t ? ' is-active' : ''}`}>
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'console' && <ConsoleTab id={d.id} running={running} isGame={isGame} containerId={d.containerId} />}
      {tab === 'files' && <FilesTab id={d.id} running={running} />}
      {tab === 'databases' && <DatabasesTab id={d.id} running={running} />}
      {tab === 'backups' && <BackupsTab />}
      {tab === 'network' && <NetworkTab />}
      {tab === 'schedules' && <SchedulesTab />}
      {tab === 'subusers' && <SubusersTab />}
      {tab === 'startup' && <StartupTab image={d.dockerImage} isGame={isGame} envs={d.events.length} />}
      {tab === 'settings' && <SettingsTab onDelete={() => toast('Delete is not wired yet', 'info')} />}
    </div>
  );
}

// Header resource stats. While the server runs they stream from the owning Node
// Agent's real `docker stats` (#67/#72); if the stream can't open (no backend,
// container not up) they fall back to the mock drift so the demo still looks
// alive. Players/TPS remain mock — Docker doesn't expose game telemetry.
function LiveStats({ id, running, isGame, containerId, startedAt }: { id: string; running: boolean; isGame: boolean; containerId: string | null; startedAt: string | null }) {
  const [s, setS] = useState({ cpu: 34, ram: 58, disk: 22, netKb: 1180, players: 7, tps: 19.9 });
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!running) return;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    // Mock drift — the fallback when the real stats stream isn't available.
    let mockTimer: ReturnType<typeof setInterval> | undefined;
    const startMock = () => {
      mockTimer = setInterval(() => {
        setS((p) => ({
          ...p,
          cpu: Math.round(clamp(p.cpu + (Math.random() * 12 - 6), 3, 96)),
          ram: Math.round(clamp(p.ram + (Math.random() * 8 - 4), 5, 97)),
          netKb: Math.round(clamp(p.netKb + (Math.random() * 500 - 250), 60, 8000)),
          players: isGame ? clamp(p.players + (Math.random() < 0.3 ? (Math.random() < 0.5 ? 1 : -1) : 0), 0, 20) : p.players,
          tps: isGame ? +clamp(p.tps + (Math.random() * 0.6 - 0.3), 12, 20).toFixed(1) : p.tps,
        }));
      }, 1500);
    };

    const ctrl = new AbortController();
    let cancelled = false;
    // Network counters are cumulative — derive a KB/s rate from consecutive samples.
    let prev: { totalKb: number; t: number } | null = null;

    streamStats(id, (st) => {
      if (cancelled) return;
      setLive(true);
      const now = Date.now();
      const totalKb = st.rxKb + st.txKb;
      let netKb = 0;
      if (prev && now > prev.t) netKb = Math.max(0, Math.round(((totalKb - prev.totalKb) / (now - prev.t)) * 1000));
      prev = { totalKb, t: now };
      setS((p) => ({ ...p, cpu: Math.round(st.cpuPercent), ram: Math.round(st.memPercent), netKb }));
    }, ctrl.signal).catch(() => {
      if (!cancelled) startMock();
    });

    return () => {
      cancelled = true;
      ctrl.abort();
      setLive(false);
      if (mockTimer) clearInterval(mockTimer);
    };
  }, [id, running, isGame, containerId]);

  const mins = running && startedAt ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000) : 0;
  const uptime = running && startedAt ? `${Math.floor(mins / 60)}h ${mins % 60}m` : '—';
  const net = running ? (s.netKb >= 1024 ? `${(s.netKb / 1024).toFixed(1)} MB/s` : `${s.netKb} KB/s`) : '—';

  return (
    <div style={{ marginBottom: 24 }}>
      {running && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, fontSize: '.72rem', color: 'var(--color-text-subtle)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? 'var(--color-success)' : 'var(--color-neutral)', animation: live ? 'pulse 1.8s ease-out infinite' : 'none' }} />
            {live ? 'live · docker stats' : 'estimated'}
          </span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
        <StatBox label="CPU" value={running ? `${s.cpu}%` : '0%'} />
        <StatBox label="Memory" value={running ? `${s.ram}%` : '0%'} />
        <StatBox label="Disk" value={`${s.disk}%`} />
        <StatBox label="Network" value={net} />
        <StatBox label="Uptime" value={uptime} />
        {isGame && <StatBox label="Players · TPS" value={running ? `${s.players}/20 · ${s.tps}` : '—'} />}
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

// ── Console — live mock stream (app/game); real logs/exec wired via #66–#72 ─
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
const hex = () => Math.random().toString(16).slice(2, 8);
const NAMES = ['Steve', 'Alex', 'Notch_', 'xX_miner', 'CreeperKing', 'Enderman42', 'pvp_god', 'BuilderBob'];
const pick = <T,>(a: T[]) => a[(Math.random() * a.length) | 0];
const appLog = (): [string, string] =>
  pick<[string, string]>([
    ['#8b949e', `GET /healthz 200 ${1 + ((Math.random() * 6) | 0)}ms`],
    ['#7ee787', `request ${hex()} 200 ${8 + ((Math.random() * 120) | 0)}ms`],
    ['#8b949e', `cache hit ratio ${(0.8 + Math.random() * 0.19).toFixed(2)}`],
    ['#7ee787', `worker tick — queue ${(Math.random() * 40) | 0}`],
    ['#e3b341', `slow query ${210 + ((Math.random() * 300) | 0)}ms`],
    ['#8b949e', 'heartbeat ok'],
  ]);
const gameLog = (): [string, string] =>
  pick<[string, string]>([
    ['#7ee787', `${pick(NAMES)} joined the game`],
    ['#e3b341', `${pick(NAMES)} left the game`],
    ['#8b949e', 'Saving chunks for level "world"'],
    ['#7ee787', `<${pick(NAMES)}> gg`],
    ['#8b949e', `Time elapsed: ${20 + ((Math.random() * 60) | 0)} ms`],
    ['#e3b341', "Can't keep up! Is the server overloaded?"],
  ]);

const lineColor = (t: string) =>
  /error|fatal|exit code|oomkilled|panic/i.test(t) ? '#f85149' : /warn|slow|overload|can't keep up/i.test(t) ? '#e3b341' : '#c9d1d9';

function ConsoleTab({ id, running, isGame, containerId }: { id: string; running: boolean; isGame: boolean; containerId: string | null }) {
  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const seqRef = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const append = (text: string, color: string) =>
    setLog((ls) => {
      const next = [...ls, { id: seqRef.current++, time: clock(), text, color }].slice(-200);
      return next;
    });

  // Try the real log stream first; fall back to a mock stream if it can't open
  // (e.g. the container isn't running, or the dashboard is run without a backend).
  useEffect(() => {
    setLog([]);
    seqRef.current = 0;
    if (!running) {
      append('process is not running — showing last output', '#e3b341');
      return;
    }
    let cancelled = false;
    let mockTimer: ReturnType<typeof setInterval> | undefined;
    const ctrl = new AbortController();

    const startMock = () => {
      append(`container ${(containerId || '').slice(0, 12)} attached`, '#7ee787');
      append('streaming stdout/stderr… (demo)', '#8b949e');
      mockTimer = setInterval(() => {
        if (Math.random() < 0.72) {
          const [color, text] = isGame ? gameLog() : appLog();
          append(text, color);
        }
      }, 1050);
    };

    streamLogs(id, (line) => !cancelled && append(line, lineColor(line)), ctrl.signal).catch(() => {
      if (!cancelled) startMock();
    });

    return () => {
      cancelled = true;
      ctrl.abort();
      if (mockTimer) clearInterval(mockTimer);
    };
  }, [id, running, isGame, containerId]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [log]);

  const send = () => {
    const c = cmd.trim();
    if (!c) return;
    // Command exec isn't wired yet (#68/#71) — echo locally with a mock response.
    append(`> ${c}`, '#c9d1d9');
    const resp = /^help$/i.test(c)
      ? isGame
        ? '/help /list /stop /op /say /tp'
        : 'available: status, restart, env, logs'
      : /^list$/i.test(c) && isGame
        ? 'There are 7/20 players online'
        : isGame
          ? `Issued server command: ${c}`
          : `${c}: ok`;
    append(resp, '#7ee787');
    setCmd('');
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
        <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: 12, color: 'var(--color-text-subtle)', border: '1px solid var(--color-border-strong)', borderRight: 'none', borderRadius: 'var(--radius) 0 0 var(--radius)', background: 'var(--color-surface)' }}>$</span>
        <input className="input mono" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="type a command and press Enter" style={{ borderLeft: 'none', borderRadius: 0, fontSize: '.85rem' }} />
        <button className="btn btn--primary" data-ripple onClick={send} style={{ borderRadius: '0 var(--radius) var(--radius) 0' }}>Send</button>
      </div>
    </>
  );
}

// ── The remaining tabs are static/mock UI, wired up later ─────────────────
function TabHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <strong style={{ fontSize: '.92rem' }}>{title}</strong>
      {action && <button className="btn btn--primary btn--sm" data-ripple data-burst="primary" onClick={onAction}>{action}</button>}
    </div>
  );
}
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
  const rename = (entry: FileEntry) => {
    const name = window.prompt('Rename to', entry.name);
    if (name?.trim() && name.trim() !== entry.name) void act(() => renamePath(id, joinPath(cwd, entry.name), joinPath(cwd, name.trim())), 'Renamed');
  };
  const remove = (entry: FileEntry) => {
    if (window.confirm(`Delete ${entry.name}? This cannot be undone.`)) void act(() => deletePath(id, joinPath(cwd, entry.name)), `Deleted ${entry.name}`);
  };
  const onUpload = async (file: File) => {
    const content = await file.text();
    void act(() => writeFile(id, joinPath(cwd, file.name), content), `Uploaded ${file.name}`);
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
  const [engine, setEngine] = useState<DatabaseEngine>(() => getDeploymentDefaults().dbEngine);
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

function BackupsTab() {
  const { toast } = useToast();
  const [backups, setBackups] = useState([
    { name: 'auto-2026-07-24', size: '184 MB', rel: '3h ago', locked: false },
    { name: 'pre-update', size: '172 MB', rel: '2d ago', locked: true },
  ]);
  const create = () => {
    const name = `manual-${Date.now().toString().slice(-6)}`;
    setBackups((xs) => [{ name, size: `${150 + ((Math.random() * 80) | 0)} MB`, rel: 'just now', locked: false }, ...xs]);
    toast(`Backup ${name} started`, 'success', 'Backup');
  };
  return (
    <>
      <TabHeader title="Backups" action="Create backup" onAction={create} />
      <div style={listCard}>
        {backups.map((b) => (
          <div key={b.name} style={rowCss}>
            <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: '.86rem', fontWeight: 600 }}>{b.name}</span>
            {b.locked && <span className="badge badge--warning">🔒 locked</span>}
            <span className="subtle tnum" style={{ fontSize: '.8rem' }}>{b.size}</span>
            <span className="subtle" style={{ fontSize: '.8rem' }}>{b.rel}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function NetworkTab() {
  const allocs = [
    { ip: '0.0.0.0', port: 8080, primary: true },
    { ip: '0.0.0.0', port: 8081, primary: false },
  ];
  return (
    <>
      <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6 }}>SFTP / FTP access</strong>
        <p className="subtle" style={{ margin: '0 0 16px', fontSize: '.84rem' }}>Connect with any SFTP client. Password is your account password.</p>
        <dl style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px 16px', fontSize: '.88rem', margin: 0 }}>
          <dt className="muted">Host</dt><dd className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>sftp.nexusinfra.local</dd>
          <dt className="muted">Port</dt><dd className="mono" style={{ margin: 0 }}>2022</dd>
          <dt className="muted">Username</dt><dd className="mono" style={{ margin: 0 }}>admin.s1</dd>
        </dl>
      </div>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>Port allocations</strong>
      <div style={listCard}>
        {allocs.map((a) => (
          <div key={a.port} style={rowCss}>
            <span className="mono" style={{ flex: 1, fontSize: '.86rem' }}>{a.ip}:{a.port}</span>
            {a.primary && <span className="badge badge--info">primary</span>}
          </div>
        ))}
      </div>
    </>
  );
}

function SchedulesTab() {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState([
    { name: 'Nightly backup', cron: '0 4 * * *', human: 'every day at 04:00', action: 'create backup', enabled: true },
    { name: 'Weekly restart', cron: '0 6 * * 1', human: 'Mondays at 06:00', action: 'restart', enabled: false },
  ]);
  const create = () => {
    setSchedules((xs) => [...xs, { name: `Task ${xs.length + 1}`, cron: '0 3 * * *', human: 'every day at 03:00', action: 'restart', enabled: true }]);
    toast('Schedule created', 'success', 'Schedule');
  };
  return (
    <>
      <TabHeader title="Schedules" action="New schedule" onAction={create} />
      <div className="stack">
        {schedules.map((s, i) => (
          <div key={s.name} style={{ ...rowCss, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 3 }}>
                <strong style={{ fontSize: '.9rem' }}>{s.name}</strong>
                <span style={{ fontSize: '.72rem', fontWeight: 600, color: s.enabled ? 'var(--color-success)' : 'var(--color-text-subtle)' }}>{s.enabled ? 'active' : 'paused'}</span>
              </div>
              <div className="subtle" style={{ fontSize: '.8rem' }}>
                <span className="mono muted">{s.cron}</span> · {s.human} · {s.action}
              </div>
            </div>
            <button className="btn btn--secondary btn--sm" data-ripple onClick={() => toast(`Ran “${s.name}”`, 'success', 'Schedule')}>Run now</button>
            <button role="switch" aria-checked={s.enabled} aria-label="Toggle schedule" onClick={() => setSchedules((xs) => xs.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))} style={{ flex: 'none', width: 44, height: 26, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer', padding: 3, transition: 'background 200ms', background: s.enabled ? 'var(--color-primary)' : 'var(--color-border-strong)' }}>
              <span style={{ display: 'block', width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'transform 200ms var(--ease-out)', transform: s.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function SubusersTab() {
  const { toast } = useToast();
  const [users, setUsers] = useState([
    { email: 'owner@nexusinfra.dev', initial: 'O', perms: 'Full access', role: 'owner', soft: 'var(--color-primary-soft)', color: 'var(--color-primary)', canRemove: false },
    { email: 'ops@nexusinfra.dev', initial: 'P', perms: 'Console, files, backups', role: 'admin', soft: 'var(--color-success-soft)', color: 'var(--color-success)', canRemove: true },
    { email: 'viewer@nexusinfra.dev', initial: 'V', perms: 'Read-only', role: 'viewer', soft: 'var(--color-neutral-soft)', color: 'var(--color-neutral)', canRemove: true },
  ]);
  const remove = (email: string) => {
    setUsers((xs) => xs.filter((u) => u.email !== email));
    toast('Access revoked', 'error', 'Subuser');
  };
  return (
    <>
      <TabHeader title="Subusers" action="Invite user" onAction={() => toast('Invites are not wired yet', 'info')} />
      <div style={listCard}>
        {users.map((u) => (
          <div key={u.email} style={rowCss}>
            <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: '50%', background: 'var(--color-primary-soft)', color: 'var(--color-primary)', fontWeight: 700, fontSize: '.85rem' }}>{u.initial}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '.88rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
              <div className="subtle" style={{ fontSize: '.78rem' }}>{u.perms}</div>
            </div>
            <span style={{ flex: 'none', fontSize: '.72rem', fontWeight: 600, padding: '3px 10px', borderRadius: 'var(--radius-full)', background: u.soft, color: u.color }}>{u.role}</span>
            {u.canRemove && <button className="icon-btn" data-ripple aria-label="Revoke access" onClick={() => remove(u.email)}>✕</button>}
          </div>
        ))}
      </div>
    </>
  );
}

function StartupTab({ image, isGame }: { image: string; isGame: boolean; envs: number }) {
  const vars = [
    { k: 'SERVER_PORT', v: '8080' },
    { k: 'MAX_MEMORY', v: '2048M' },
    { k: 'EULA', v: 'true' },
  ];
  return (
    <>
      <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>Startup command</strong>
        <div className="mono" style={{ fontSize: '.84rem', background: '#0a0e16', color: '#c9d1d9', padding: '12px 14px', borderRadius: 'var(--radius)', wordBreak: 'break-all' }}>
          docker run {image} --port 8080
        </div>
        {isGame && (
          <div style={{ marginTop: 14, display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '.86rem' }}>
            <span><span className="muted">Software:</span> <strong style={{ textTransform: 'capitalize' }}>paper</strong></span>
            <span><span className="muted">Version:</span> <strong className="mono">1.20.4</strong></span>
          </div>
        )}
      </div>
      <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 12 }}>Environment variables</strong>
      <div style={listCard}>
        {vars.map((e) => (
          <div key={e.k} style={rowCss}>
            <span className="mono" style={{ flex: 'none', minWidth: 160, fontSize: '.84rem', fontWeight: 600 }}>{e.k}</span>
            <span className="mono muted" style={{ fontSize: '.84rem' }}>{e.v}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SettingsTab({ onDelete }: { onDelete: () => void }) {
  const { toast } = useToast();
  return (
    <>
      <div className="card" style={{ padding: '20px 22px', marginBottom: 18 }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6 }}>Reinstall server</strong>
        <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>Re-run the install script. Your data files are preserved.</p>
        <button className="btn btn--secondary btn--sm" data-ripple onClick={() => toast('Not wired yet', 'info')}>Reinstall</button>
      </div>
      <div className="card" style={{ padding: '20px 22px', borderColor: 'var(--color-danger-soft)' }}>
        <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: 6, color: 'var(--color-danger)' }}>Delete server</strong>
        <p className="subtle" style={{ margin: '0 0 14px', fontSize: '.84rem' }}>Permanently removes this server and all of its files. This cannot be undone.</p>
        <button className="btn btn--primary btn--sm" data-ripple data-burst="danger" onClick={onDelete} style={{ background: 'var(--color-danger)' }}>Delete server</button>
      </div>
    </>
  );
}
