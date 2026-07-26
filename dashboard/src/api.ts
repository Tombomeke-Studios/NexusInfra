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
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  health: NodeHealth;
}

export interface DeploymentView {
  id: string;
  name: string;
  dockerImage: string;
  type: string;
  nodeId: string | null;
  containerId: string | null;
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

export interface CreateDeploymentInput {
  name: string;
  dockerImage: string;
  ports?: Record<string, string>;
  env?: Record<string, string>;
  resourceLimits?: ResourceLimits;
  autoRestart?: boolean;
  type?: string;
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

export function login(username: string, password: string): Promise<{ token: string }> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
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

export function getBillingPlan(): Promise<BillingPlan> {
  return request('/billing/plan');
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

export function stopDeployment(id: string): Promise<{ status: string; deploymentId: string }> {
  return request(`/deployments/${id}/stop`, { method: 'POST' });
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
export type SubuserRole = 'admin' | 'viewer';

export interface ServerSubuser {
  id: string;
  deploymentId: string;
  email: string;
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
