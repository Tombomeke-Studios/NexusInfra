// Domain types + the Repository interface. These are deliberately decoupled from
// Prisma so the logic modules (node selection, registry, lifecycle, API) depend on
// an interface, not a concrete database — enabling an in-memory fake in tests.

export type DeploymentStatus = 'pending' | 'running' | 'stopped' | 'crashed' | 'failed';

export type NodeHealth = 'healthy' | 'degraded' | 'offline';

export interface NodeRecord {
  id: string;
  name: string;
  ipAddress: string | null;
  lastHeartbeat: string; // ISO-8601 UTC
  cpuPercent: number | null;
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
}

/**
 * The resource caps and runtime behaviour chosen for a server. Persisted with the
 * config (#106) so a re-start reuses them and the enforcement pass (#107) can read
 * them; every field is optional so older/partial configs round-trip cleanly.
 */
export interface ResourceLimits {
  cpuPercent?: number; // share of the host node's CPU, 0–100
  ramPercent?: number; // share of the host node's RAM, 0–100
  diskPercent?: number; // share of the host node's disk, 0–100
  swapPercent?: number; // swap as a share of the RAM limit, 0–100
  ioPriority?: 'low' | 'normal' | 'high';
  restartPolicy?: 'no' | 'on-failure' | 'always';
  oomKill?: boolean; // kill the container when it exceeds its RAM limit
}

export interface ServerConfigRecord {
  id: string;
  userId: string;
  name: string;
  dockerImage: string;
  ports: Record<string, string>;
  env: Record<string, string>;
  resourceLimits: ResourceLimits;
  autoRestart: boolean;
  type: string;
  createdAt: string;
}

export interface DeploymentRecord {
  id: string;
  serverConfigId: string;
  nodeId: string | null;
  containerId: string | null;
  status: DeploymentStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

/** A deployment joined with its config — what the API/dashboard render in a list. */
export interface DeploymentView extends DeploymentRecord {
  name: string;
  dockerImage: string;
  userId: string;
}

export interface DeploymentEventRecord {
  id: string;
  deploymentId: string;
  event: string;
  message: string;
  timestamp: string;
}

export interface DeploymentDetail extends DeploymentView {
  events: DeploymentEventRecord[];
}

export interface UpsertNodeInput {
  id: string;
  name?: string;
  ipAddress?: string | null;
  lastHeartbeat: string;
  cpuPercent?: number | null;
  ramUsedMb?: number | null;
  ramTotalMb?: number | null;
  diskUsedGb?: number | null;
  diskTotalGb?: number | null;
}

export interface CreateServerConfigInput {
  userId: string;
  name: string;
  dockerImage: string;
  ports?: Record<string, string>;
  env?: Record<string, string>;
  resourceLimits?: ResourceLimits;
  autoRestart?: boolean;
  type?: string;
}

export interface DeploymentStatusPatch {
  status?: DeploymentStatus;
  nodeId?: string | null;
  containerId?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
}

/**
 * Persistence boundary for the Orchestrator. Implemented by PrismaRepository
 * (production, SQLite) and InMemoryRepository (tests, and a DB-less local mode).
 */
export interface Repository {
  upsertNode(input: UpsertNodeInput): Promise<NodeRecord>;
  listNodes(): Promise<NodeRecord[]>;

  createServerConfig(input: CreateServerConfigInput): Promise<ServerConfigRecord>;
  createDeployment(serverConfigId: string, nodeId: string | null): Promise<DeploymentRecord>;
  updateDeploymentStatus(id: string, patch: DeploymentStatusPatch): Promise<DeploymentRecord | null>;
  appendDeploymentEvent(deploymentId: string, event: string, message: string): Promise<void>;

  listDeployments(): Promise<DeploymentView[]>;
  getDeployment(id: string): Promise<DeploymentDetail | null>;
  /** The server config behind a deployment (image/ports/env), for re-starting it. */
  getDeploymentConfig(deploymentId: string): Promise<ServerConfigRecord | null>;
}
