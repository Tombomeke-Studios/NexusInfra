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
  /** The team this server is shared with, if any (#177). */
  teamId: string | null;
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
  teamId: string | null;
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

/** A group that shares servers (#177). */
export interface TeamRecord {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export interface TeamMemberRecord {
  id: string;
  teamId: string;
  userId: string;
  role: string;
  createdAt: string;
}

/** A member joined with the account behind it — what the Teams page renders. */
export interface TeamMemberView extends TeamMemberRecord {
  email: string;
  displayName: string;
}

/** `pending` = invited but not yet bound to an account, and carries no access (#176). */
export type SubuserStatus = 'pending' | 'active';

export interface ServerSubuserRecord {
  id: string;
  deploymentId: string;
  email: string;
  userId: string | null;
  status: string;
  role: string;
  createdAt: string;
}

export interface CreateServerSubuserInput {
  deploymentId: string;
  email: string;
  role: string;
  userId?: string | null;
  status?: string;
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

/**
 * One server, everything the detail page needs: the deployment, its audit trail,
 * and the runtime configuration it was created with. The config lives here
 * because the Network and Startup tabs render it — without it they had nothing
 * true to show and displayed invented values (#217, #218).
 */
export interface DeploymentDetail extends DeploymentView {
  events: DeploymentEventRecord[];
  ports: Record<string, string>;
  env: Record<string, string>;
  resourceLimits: ResourceLimits;
  autoRestart: boolean;
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
  teamId?: string | null;
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

  // Teams (#177).
  createTeam(input: { id: string; name: string; ownerId: string }): Promise<TeamRecord>;
  getTeam(id: string): Promise<TeamRecord | null>;
  /** Teams this person owns or belongs to. */
  listTeamsForUser(userId: string): Promise<TeamRecord[]>;
  deleteTeam(id: string): Promise<void>;
  addTeamMember(input: { teamId: string; userId: string; role: string }): Promise<TeamMemberRecord>;
  listTeamMembers(teamId: string): Promise<TeamMemberView[]>;
  /** This person's standing in one team, if they belong to it — the authorization lookup. */
  getTeamMember(teamId: string, userId: string): Promise<TeamMemberRecord | null>;
  removeTeamMember(teamId: string, userId: string): Promise<void>;
  /** Attach a server to a team, or detach it with null. */
  setServerTeam(serverConfigId: string, teamId: string | null): Promise<void>;

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
  /**
   * Deployments this person may see: the ones they own plus the ones shared with
   * them (#175). Shares are addressed by email until they are bound to accounts
   * (#176), so both identifiers are needed.
   */
  listDeploymentsForUser(user: { id: string; email: string }): Promise<DeploymentView[]>;
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
  /** The share held by one person on one server, if any — the authorization lookup. */
  getSubuserFor(deploymentId: string, email: string): Promise<ServerSubuserRecord | null>;
  /**
   * Bind every pending invitation addressed to `email` to that account and
   * activate it (#176). Called when the person first appears; returns how many
   * were claimed.
   */
  claimSubuserInvites(userId: string, email: string): Promise<number>;
  updateSubuserRole(id: string, role: string): Promise<ServerSubuserRecord | null>;
  deleteSubuser(id: string): Promise<void>;
}
