// Typed client for the Orchestrator HTTP API (:9200). In dev the base URL is
// `/api`, which Vite proxies to the Orchestrator (see vite.config.ts); override
// with VITE_ORCHESTRATOR_URL for other setups. The JWT (set by the login page)
// is read from localStorage and sent as a Bearer token.

const BASE = (import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined) ?? '/api';

export const TOKEN_KEY = 'nexusinfra.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export type DeploymentStatus = 'pending' | 'running' | 'stopped' | 'crashed' | 'failed';
export type NodeHealth = 'healthy' | 'degraded' | 'offline';

export interface NodeView {
  id: string;
  name: string;
  location?: string; // free-form label for a self-hosted node (e.g. "home-server")
  lastHeartbeat: string;
  cpuPercent: number | null;
  /** The node's real CPU count; null until its agent reports one (#261). */
  cpuCores?: number | null;
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  health: NodeHealth;
  /** Drained on purpose (#258): still running, but taking nothing new. */
  maintenance?: boolean;
}

export interface DeploymentView {
  id: string;
  name: string;
  dockerImage: string;
  type: string;
  /** The account that owns this server — not necessarily the caller (#178). */
  userId?: string;
  /** The team this server is shared with, if any (#177). */
  teamId?: string | null;
  /** The caller's role on this server (#175) — absent only on older responses. */
  role?: 'owner' | 'admin' | 'operator' | 'viewer';
  nodeId: string | null;
  containerId: string | null;
  /** The caps this server was given — summed per node for "committed" (#261). */
  resourceLimits?: ResourceLimits;
  status: DeploymentStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

export interface DeploymentEvent {
  id: string;
  event: string;
  message: string;
  timestamp: string;
}

export interface DeploymentDetail extends DeploymentView {
  events: DeploymentEvent[];
  /** Host port → container port, as configured at creation (#217). */
  ports: Record<string, string>;
  /** The server's own environment variables (#218). */
  env: Record<string, string>;
  resourceLimits: ResourceLimits;
  autoRestart: boolean;
}

export interface ResourceLimits {
  cpuPercent?: number;
  ramPercent?: number;
  diskPercent?: number;
  swapPercent?: number;
  ioPriority?: 'low' | 'normal' | 'high';
  restartPolicy?: 'no' | 'on-failure' | 'always';
  oomKill?: boolean;
}

// ── Eggs (#231) — the recipes a server can be created from ────────────────────
export type EggVariableKind = 'string' | 'integer' | 'boolean' | 'choice';

export interface EggVariable {
  key: string;
  label: string;
  description: string;
  kind: EggVariableKind;
  default: string;
  options?: string[];
  min?: number;
  max?: number;
}

export interface Egg {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  ports: Record<string, string>;
  dataPath: string;
  variables: EggVariable[];
}

/**
 * The egg catalogue. Fetched rather than bundled: the orchestrator owns the
 * recipes and validates against them, so the panel renders whatever it is told
 * about instead of keeping a copy that could drift.
 */
export function listEggs(): Promise<Egg[]> {
  return request('/eggs');
}

/**
 * Creating a server is one of two things, and the types say so: an egg decides
 * its own image (#231), or you name an image yourself. Requiring both would let
 * a caller send an image that is then ignored.
 */
export type CreateDeploymentInput = CreateDeploymentBase &
  ({
    eggId: string;
    eggValues?: Record<string, string>;
    dockerImage?: never;
    /** Import an existing directory on the node as this server's data (#268). */
    dataPath?: string;
  } | { dockerImage: string; eggId?: never });

interface CreateDeploymentBase {
  name: string;
  ports?: Record<string, string>;
  env?: Record<string, string>;
  resourceLimits?: ResourceLimits;
  autoRestart?: boolean;
  type?: string;
  /** Pin the server to a node; omit to let the orchestrator pick the emptiest (#254). */
  nodeId?: string;
}

/** Thrown when the API responds with a non-2xx status; carries the HTTP status. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  // Some 2xx responses have no body (e.g. mkdir returns 201 with no payload);
  // parsing an empty body would throw, so treat "no JSON" as no content.
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

// ── Accounts (#174) ───────────────────────────────────────────────────────────
export type PlatformRole = 'owner' | 'admin' | 'user';

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  platformRole: PlatformRole;
  createdAt: string;
}

/** Accepts an email, or the legacy username for installs that predate accounts. */
export function login(email: string, password: string): Promise<{ token: string }> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

/** Self-registration — only reachable in the hosted edition; 403 otherwise. */
export function register(email: string, password: string, displayName?: string): Promise<{ token: string; user: CurrentUser }> {
  return request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
}

export function getCurrentUser(): Promise<CurrentUser> {
  return request('/me');
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
}

/** Administrator-only account list — how a panel admin sees who has access. */
export function listUsers(): Promise<CurrentUser[]> {
  return request('/users');
}

/** Administrator-created account: the way in when self-registration is closed. */
export function createUser(input: { email: string; password: string; displayName?: string; platformRole?: PlatformRole }): Promise<CurrentUser> {
  return request('/users', { method: 'POST', body: JSON.stringify(input) });
}

// ── Runtime config (edition flag) ─────────────────────────────────────────────
export type Edition = 'community' | 'hosted';

export interface AppConfig {
  edition: Edition;
}

/** Public config — read before login to decide whether billing UI renders (#144). */
export function getConfig(): Promise<AppConfig> {
  return request('/config');
}

// ── Billing (hosted edition; proxied through the orchestrator, #149) ───────────
export interface CreditWallet {
  userId: string;
  balance: number;
  currency: string;
}

export interface BillingPlan {
  id: string;
  name: string;
  pricePerHour: number;
  currency: string;
  freeHoursPerMonth: number;
  maxServers: number;
  maxDatabases: number;
}

export interface BillingUsage {
  hours: number;
  cost: number;
  plan: BillingPlan;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  type: 'topup' | 'charge';
  amount: number;
  currency: string;
  reference: string;
  status: 'pending' | 'confirmed' | 'failed';
  description: string;
  createdAt: string;
}

export function getWallet(): Promise<CreditWallet> {
  return request('/billing/wallet');
}

export function getUsage(): Promise<BillingUsage> {
  return request('/billing/usage');
}

export function getLedger(): Promise<LedgerEntry[]> {
  return request('/billing/ledger');
}

export function topUp(amount: number): Promise<{ status: string; reference: string }> {
  return request('/billing/topup', { method: 'POST', body: JSON.stringify({ amount }) });
}

export function listNodes(): Promise<NodeView[]> {
  return request('/nodes');
}

// ── Service monitoring (Control Room, proxied via the orchestrator, #157) ──────
export interface MonitoredService {
  source: string;
  status: NodeHealth;
  lastSeenMsAgo: number;
  /** Share of observed time this source was healthy, 0–100 (#165). */
  uptimePercent?: number;
}

export interface MonitoringSnapshot {
  monitored: MonitoredService[];
  reachable: boolean;
}

/** The Control Room's live view of every service/node heartbeat on the bus. */
export function getMonitoring(): Promise<MonitoringSnapshot> {
  return request('/monitoring');
}

/** Register (or relabel) a node's metadata (#113). It reads offline until its agent connects. */
export function registerNode(input: { id?: string; name?: string; location?: string }): Promise<NodeView> {
  return request('/nodes', { method: 'POST', body: JSON.stringify(input) });
}

/** Drain a node, or put it back in the placement pool (#258). Platform admins only. */
export function setNodeMaintenance(id: string, maintenance: boolean): Promise<NodeView> {
  return request(`/nodes/${id}/maintenance`, { method: 'PATCH', body: JSON.stringify({ maintenance }) });
}

export function deregisterNode(id: string): Promise<void> {
  return request(`/nodes/${id}`, { method: 'DELETE' });
}

export function listDeployments(): Promise<DeploymentView[]> {
  return request('/deployments');
}

export function getDeployment(id: string): Promise<DeploymentDetail> {
  return request(`/deployments/${id}`);
}

export function createDeployment(input: CreateDeploymentInput): Promise<DeploymentDetail> {
  return request('/deployments', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * A server's audit trail, newest first (#223). Written since the beginning and
 * never read back until now, which is why "who stopped this" was unanswerable.
 */
export function listDeploymentEvents(id: string, opts: { limit?: number; offset?: number } = {}): Promise<DeploymentEvent[]> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.offset != null) q.set('offset', String(opts.offset));
  const qs = q.toString();
  return request(`/deployments/${id}/events${qs ? `?${qs}` : ''}`);
}

export interface UpdateDeploymentInput {
  name?: string;
  dockerImage?: string;
  ports?: Record<string, string>;
  env?: Record<string, string>;
  resourceLimits?: ResourceLimits;
  autoRestart?: boolean;
}

/**
 * Change an existing server's configuration (#220). Omitted fields are left
 * alone, and nothing restarts — the change lands on the server's next start.
 */
export function updateDeployment(id: string, patch: UpdateDeploymentInput): Promise<DeploymentDetail> {
  return request(`/deployments/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function stopDeployment(id: string): Promise<{ status: string; deploymentId: string }> {
  return request(`/deployments/${id}/stop`, { method: 'POST' });
}

/** Force-terminate (SIGKILL) a container that will not stop gracefully (#253). */
export function killDeployment(id: string): Promise<{ status: string; deploymentId: string }> {
  return request(`/deployments/${id}/kill`, { method: 'POST' });
}

export function restartDeployment(id: string): Promise<{ status: string; deploymentId: string }> {
  return request(`/deployments/${id}/restart`, { method: 'POST' });
}

export function startDeployment(id: string): Promise<{ status: string; deploymentId: string }> {
  return request(`/deployments/${id}/start`, { method: 'POST' });
}

/** Permanently delete a deployment (stops it first if running). */
export function deleteDeployment(id: string): Promise<void> {
  return request(`/deployments/${id}`, { method: 'DELETE' });
}

/** Live per-container resource stats — the dashboard renders these live (#72). */
export interface ContainerStats {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
  memPercent: number;
  rxKb: number;
  txKb: number;
}

/**
 * Consume a deployment's SSE stream (over a streaming fetch, so the JWT stays in
 * the Authorization header), invoking `onData` with each event's `data` payload.
 * Resolves when the stream ends; rejects if it can't be opened. `signal` aborts.
 */
async function streamSse(path: string, onData: (data: string) => void, signal: AbortSignal): Promise<void> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new ApiError(res.status, 'stream unavailable');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const evt = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = evt
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onData(data);
    }
  }
}

// ── Container file management (#108) ──────────────────────────────────────────
export interface FileEntry {
  name: string;
  kind: 'file' | 'dir';
  size: number;
}

export function listFiles(id: string, path: string): Promise<FileEntry[]> {
  return request(`/deployments/${id}/files?path=${encodeURIComponent(path)}`);
}

export function readFile(id: string, path: string): Promise<{ path: string; content: string }> {
  return request(`/deployments/${id}/files/content?path=${encodeURIComponent(path)}`);
}

export function writeFile(id: string, path: string, content: string): Promise<void> {
  return request(`/deployments/${id}/files/content`, { method: 'PUT', body: JSON.stringify({ path, content }) });
}

/**
 * Upload a file's raw bytes (#263). Deliberately not `writeFile`: that sends a
 * JSON string, and decoding a binary file to text replaces every invalid byte,
 * so a JAR or zip arrived corrupt while the panel reported success.
 */
export async function uploadFile(id: string, path: string, file: Blob): Promise<void> {
  const token = getToken();
  const res = await fetch(`${BASE}/deployments/${id}/files/binary?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new ApiError(res.status, message);
  }
}

export function makeDir(id: string, path: string): Promise<void> {
  return request(`/deployments/${id}/files/dir`, { method: 'POST', body: JSON.stringify({ path }) });
}

export function renamePath(id: string, from: string, to: string): Promise<void> {
  return request(`/deployments/${id}/files/rename`, { method: 'POST', body: JSON.stringify({ from, to }) });
}

export function deletePath(id: string, path: string): Promise<void> {
  return request(`/deployments/${id}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
}

// ── Managed databases (#109) ──────────────────────────────────────────────────
export type DatabaseEngine = 'mysql' | 'mariadb' | 'postgres';

export interface ServerDatabase {
  id: string;
  deploymentId: string;
  engine: string;
  name: string;
  username: string;
  password: string;
  host: string;
  port: number;
  status: string;
  createdAt: string;
}

export function listDatabases(id: string): Promise<ServerDatabase[]> {
  return request(`/deployments/${id}/databases`);
}

export function createDatabase(id: string, engine: DatabaseEngine): Promise<ServerDatabase> {
  return request(`/deployments/${id}/databases`, { method: 'POST', body: JSON.stringify({ engine }) });
}

export function deleteDatabase(id: string, dbId: string): Promise<void> {
  return request(`/deployments/${id}/databases/${dbId}`, { method: 'DELETE' });
}

// ── Backups (#110) ────────────────────────────────────────────────────────────
export interface ServerBackup {
  id: string;
  deploymentId: string;
  name: string;
  path: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export function listBackups(id: string): Promise<ServerBackup[]> {
  return request(`/deployments/${id}/backups`);
}

export function createBackup(id: string): Promise<ServerBackup> {
  return request(`/deployments/${id}/backups`, { method: 'POST', body: JSON.stringify({}) });
}

export function restoreBackup(id: string, backupId: string): Promise<{ status: string }> {
  return request(`/deployments/${id}/backups/${backupId}/restore`, { method: 'POST' });
}

export function deleteBackup(id: string, backupId: string): Promise<void> {
  return request(`/deployments/${id}/backups/${backupId}`, { method: 'DELETE' });
}

// ── Schedules (#111) ──────────────────────────────────────────────────────────
export type ScheduleAction = 'restart' | 'backup';

export interface ServerSchedule {
  id: string;
  deploymentId: string;
  name: string;
  cron: string;
  action: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export function listSchedules(id: string): Promise<ServerSchedule[]> {
  return request(`/deployments/${id}/schedules`);
}

export function createSchedule(id: string, input: { name: string; cron: string; action: ScheduleAction }): Promise<ServerSchedule> {
  return request(`/deployments/${id}/schedules`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateSchedule(id: string, sid: string, patch: Partial<{ name: string; cron: string; action: ScheduleAction; enabled: boolean }>): Promise<ServerSchedule> {
  return request(`/deployments/${id}/schedules/${sid}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteSchedule(id: string, sid: string): Promise<void> {
  return request(`/deployments/${id}/schedules/${sid}`, { method: 'DELETE' });
}

export function runSchedule(id: string, sid: string): Promise<{ status: string }> {
  return request(`/deployments/${id}/schedules/${sid}/run`, { method: 'POST' });
}

// ── Subusers (#112) ───────────────────────────────────────────────────────────
/**
 * Roles that can be granted to someone else (#175). `operator` is the one this
 * feature exists for: run my server, but don't read its files or reshare it.
 * Ownership is never grantable.
 */
export type SubuserRole = 'admin' | 'operator' | 'viewer';

export const SUBUSER_ROLE_LABELS: Record<SubuserRole, string> = {
  viewer: 'Viewer — see status, logs and usage',
  operator: 'Operator — start, stop, restart and console',
  admin: 'Admin — everything except deleting the server',
};

/** `pending` = invited but not yet signed up; the grant is inert until they are (#176). */
export type SubuserStatus = 'pending' | 'active';

export interface ServerSubuser {
  id: string;
  deploymentId: string;
  email: string;
  userId: string | null;
  status: SubuserStatus;
  role: string;
  createdAt: string;
}

export function listSubusers(id: string): Promise<ServerSubuser[]> {
  return request(`/deployments/${id}/subusers`);
}

export function inviteSubuser(id: string, email: string, role: SubuserRole): Promise<ServerSubuser> {
  return request(`/deployments/${id}/subusers`, { method: 'POST', body: JSON.stringify({ email, role }) });
}

export function updateSubuserRole(id: string, sid: string, role: SubuserRole): Promise<ServerSubuser> {
  return request(`/deployments/${id}/subusers/${sid}`, { method: 'PATCH', body: JSON.stringify({ role }) });
}

export function removeSubuser(id: string, sid: string): Promise<void> {
  return request(`/deployments/${id}/subusers/${sid}`, { method: 'DELETE' });
}

// ── Console exec (#68) ────────────────────────────────────────────────────────
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run a one-shot command in the running container and return its output. */
export function execCommand(id: string, command: string): Promise<ExecResult> {
  return request(`/deployments/${id}/exec`, { method: 'POST', body: JSON.stringify({ command }) });
}

/**
 * WebSocket URL for a deployment's interactive terminal (#71). The JWT rides as a
 * query param (browsers can't set WS headers). `location` is injectable for tests.
 */
export function terminalWsUrl(
  id: string,
  cols: number,
  rows: number,
  location: { host: string; secure: boolean; token: string | null } = { host: window.location.host, secure: window.location.protocol === 'https:', token: getToken() }
): string {
  const query = `token=${encodeURIComponent(location.token ?? '')}&cols=${cols}&rows=${rows}`;
  const path = `/deployments/${id}/terminal?${query}`;
  // When BASE is an absolute http(s) URL, swap the scheme to ws(s); otherwise it's
  // a relative path (`/api`) served on the current origin.
  if (BASE.startsWith('http')) return `${BASE.replace(/^http/, 'ws')}${path}`;
  return `${location.secure ? 'wss' : 'ws'}://${location.host}${BASE}${path}`;
}

/** Streams a deployment's container logs (SSE). See {@link streamSse}. */
export function streamLogs(id: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
  return streamSse(`/deployments/${id}/logs`, onLine, signal);
}

/** Streams a deployment's live resource stats (SSE). See {@link streamSse}. */
export function streamStats(id: string, onStats: (stats: ContainerStats) => void, signal: AbortSignal): Promise<void> {
  return streamSse(`/deployments/${id}/stats`, (data) => {
    try {
      onStats(JSON.parse(data) as ContainerStats);
    } catch {
      // Ignore a malformed sample; the next one follows.
    }
  }, signal);
}

// ── Teams (#177) ──────────────────────────────────────────────────────────────
export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
}

/** Teams the caller owns or belongs to. */
export function listTeams(): Promise<Team[]> {
  return request('/teams');
}

export function getTeam(id: string): Promise<TeamDetail> {
  return request(`/teams/${id}`);
}

export function createTeam(name: string): Promise<Team> {
  return request('/teams', { method: 'POST', body: JSON.stringify({ name }) });
}

export function deleteTeam(id: string): Promise<void> {
  return request(`/teams/${id}`, { method: 'DELETE' });
}

/** The invitee must already have an account — a team grants access to every server it holds. */
export function addTeamMember(id: string, email: string, role: SubuserRole): Promise<TeamMember> {
  return request(`/teams/${id}/members`, { method: 'POST', body: JSON.stringify({ email, role }) });
}

export function updateTeamMemberRole(id: string, userId: string, role: SubuserRole): Promise<TeamMember> {
  return request(`/teams/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
}

/** Removing yourself is how you leave a team. */
export function removeTeamMember(id: string, userId: string): Promise<void> {
  return request(`/teams/${id}/members/${userId}`, { method: 'DELETE' });
}

/** Share a server with a team, or detach it with null. Requires ownership. */
export function setServerTeam(deploymentId: string, teamId: string | null): Promise<{ deploymentId: string; teamId: string | null }> {
  return request(`/deployments/${deploymentId}/team`, { method: 'PATCH', body: JSON.stringify({ teamId }) });
}
