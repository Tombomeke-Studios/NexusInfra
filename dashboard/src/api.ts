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

export interface CreateDeploymentInput {
  name: string;
  dockerImage: string;
  ports?: Record<string, string>;
  env?: Record<string, string>;
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
  return (await res.json()) as T;
}

export function login(username: string, password: string): Promise<{ token: string }> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function listNodes(): Promise<NodeView[]> {
  return request('/nodes');
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
