// Domain types + the Repository interface. These are deliberately decoupled from
// Prisma so the logic modules (node selection, registry, lifecycle, API) depend on
// an interface, not a concrete database — enabling an in-memory fake in tests.

import type { ResourceLimits } from 'shared';

// Re-exported so the rest of the Orchestrator imports it from one place; the
// canonical definition lives in shared (it also rides on the server.start event).
export type { ResourceLimits };

export type DeploymentStatus = 'pending' | 'running' | 'stopped' | 'crashed' | 'failed';

/** A panel account (#174). `passwordHash` never leaves the service — see `toPublicUser`. */
export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  platformRole: string;
  createdAt: string;
}

export interface CreateUserInput {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  platformRole: string;
}

export type NodeHealth = 'healthy' | 'degraded' | 'offline';

export interface NodeRecord {
  id: string;
  name: string;
  location: string | null;
  ipAddress: string | null;
  /** Base URL of this node's agent HTTP API; null until the node reports one (#171). */
  agentUrl: string | null;
  lastHeartbeat: string; // ISO-8601 UTC
  cpuPercent: number | null;
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
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
  type: string;
}

export type DatabaseEngine = 'mysql' | 'mariadb' | 'postgres';

export interface ServerDatabaseRecord {
  id: string;
  deploymentId: string;
  engine: string;
  name: string;
  username: string;
  password: string;
  host: string;
  port: number;
  containerId: string | null;
  status: string;
  createdAt: string;
}

export interface CreateServerDatabaseInput {
  deploymentId: string;
  engine: string;
  name: string;
  username: string;
  password: string;
  host: string;
  port: number;
  containerId: string | null;
}

export interface ServerBackupRecord {
  id: string;
  deploymentId: string;
  name: string;
  path: string;
  ref: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

export interface CreateServerBackupInput {
  deploymentId: string;
  name: string;
  path: string;
  ref: string;
  sizeBytes: number;
}

export type SubuserRole = 'admin' | 'viewer';

export interface ServerSubuserRecord {
  id: string;
  deploymentId: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface CreateServerSubuserInput {
  deploymentId: string;
  email: string;
  role: string;
}

export type ScheduleAction = 'restart' | 'backup';

export interface ServerScheduleRecord {
  id: string;
  deploymentId: string;
  name: string;
  cron: string;
  action: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface CreateServerScheduleInput {
  deploymentId: string;
  name: string;
  cron: string;
  action: string;
  enabled?: boolean;
}

export interface UpdateServerScheduleInput {
  name?: string;
  cron?: string;
  action?: string;
  enabled?: boolean;
  lastRunAt?: string | null;
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
  location?: string | null;
  ipAddress?: string | null;
  agentUrl?: string | null;
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
/** Register/relabel a node's human metadata without touching its liveness/resources (#113). */
export interface RegisterNodeInput {
  id: string;
  name?: string;
  location?: string | null;
  /** Explicitly set the node's agent base URL (#171); otherwise learned from heartbeats. */
  agentUrl?: string | null;
}

export interface Repository {
  // Accounts (#174).
  createUser(input: CreateUserInput): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  countUsers(): Promise<number>;
  setUserPassword(id: string, passwordHash: string): Promise<UserRecord | null>;

  upsertNode(input: UpsertNodeInput): Promise<NodeRecord>;
  listNodes(): Promise<NodeRecord[]>;
  /** Create or relabel a node (name/location); leaves lastHeartbeat/resources intact. */
  registerNode(input: RegisterNodeInput): Promise<NodeRecord>;
  /** Remove a node record; detaches it from any deployments first. */
  deleteNode(id: string): Promise<void>;

  createServerConfig(input: CreateServerConfigInput): Promise<ServerConfigRecord>;
  createDeployment(serverConfigId: string, nodeId: string | null): Promise<DeploymentRecord>;
  updateDeploymentStatus(id: string, patch: DeploymentStatusPatch): Promise<DeploymentRecord | null>;
  appendDeploymentEvent(deploymentId: string, event: string, message: string): Promise<void>;

  listDeployments(): Promise<DeploymentView[]>;
  getDeployment(id: string): Promise<DeploymentDetail | null>;
  /** The server config behind a deployment (image/ports/env), for re-starting it. */
  getDeploymentConfig(deploymentId: string): Promise<ServerConfigRecord | null>;
  /** Remove a deployment and all of its child records (events/databases/backups/schedules/subusers). */
  deleteDeployment(id: string): Promise<void>;

  // Managed databases (#109).
  createDatabase(input: CreateServerDatabaseInput): Promise<ServerDatabaseRecord>;
  listDatabases(deploymentId: string): Promise<ServerDatabaseRecord[]>;
  getDatabase(id: string): Promise<ServerDatabaseRecord | null>;
  deleteDatabase(id: string): Promise<void>;

  // Backups (#110).
  createBackup(input: CreateServerBackupInput): Promise<ServerBackupRecord>;
  listBackups(deploymentId: string): Promise<ServerBackupRecord[]>;
  getBackup(id: string): Promise<ServerBackupRecord | null>;
  deleteBackup(id: string): Promise<void>;

  // Schedules (#111).
  createSchedule(input: CreateServerScheduleInput): Promise<ServerScheduleRecord>;
  listSchedules(deploymentId: string): Promise<ServerScheduleRecord[]>;
  listAllSchedules(): Promise<ServerScheduleRecord[]>;
  getSchedule(id: string): Promise<ServerScheduleRecord | null>;
  updateSchedule(id: string, patch: UpdateServerScheduleInput): Promise<ServerScheduleRecord | null>;
  deleteSchedule(id: string): Promise<void>;

  // Subusers (#112).
  createSubuser(input: CreateServerSubuserInput): Promise<ServerSubuserRecord>;
  listSubusers(deploymentId: string): Promise<ServerSubuserRecord[]>;
  getSubuser(id: string): Promise<ServerSubuserRecord | null>;
  updateSubuserRole(id: string, role: string): Promise<ServerSubuserRecord | null>;
  deleteSubuser(id: string): Promise<void>;
}
