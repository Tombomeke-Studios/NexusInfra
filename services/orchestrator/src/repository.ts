import { randomUUID } from 'crypto';
import type {
  CreateServerBackupInput,
  CreateServerConfigInput,
  CreateServerDatabaseInput,
  CreateServerScheduleInput,
  CreateServerSubuserInput,
  CreateUserInput,
  DeploymentDetail,
  DeploymentEventRecord,
  DeploymentRecord,
  DeploymentStatusPatch,
  DeploymentView,
  NodeRecord,
  RegisterNodeInput,
  Repository,
  ServerBackupRecord,
  ServerConfigRecord,
  ServerDatabaseRecord,
  ServerScheduleRecord,
  ServerSubuserRecord,
  TeamMemberRecord,
  TeamMemberView,
  TeamRecord,
  UpdateServerScheduleInput,
  UpsertNodeInput,
  UserRecord,
} from './types.js';

/**
 * In-memory Repository implementation.
 *
 * Used by unit tests (no database needed) and as a DB-less fallback for local
 * development. Behaviour must match PrismaRepository (db.ts) — the shared
 * contract test exercises this implementation.
 */
export class InMemoryRepository implements Repository {
  private users = new Map<string, UserRecord>();
  private teams = new Map<string, TeamRecord>();
  private teamMembers = new Map<string, TeamMemberRecord>();
  private nodes = new Map<string, NodeRecord>();
  private configs = new Map<string, ServerConfigRecord>();
  private deployments = new Map<string, DeploymentRecord>();
  private events: DeploymentEventRecord[] = [];
  private databases = new Map<string, ServerDatabaseRecord>();
  private backups = new Map<string, ServerBackupRecord>();
  private schedules = new Map<string, ServerScheduleRecord>();
  private subusers = new Map<string, ServerSubuserRecord>();

  // ── Accounts (#174) ─────────────────────────────────────────────────────────
  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const user: UserRecord = { ...input, createdAt: new Date().toISOString() };
    this.users.set(user.id, user);
    return user;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()];
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async setUserPassword(id: string, passwordHash: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;
    const updated = { ...user, passwordHash };
    this.users.set(id, updated);
    return updated;
  }

  // ── Teams (#177) ────────────────────────────────────────────────────────────
  async createTeam(input: { id: string; name: string; ownerId: string }): Promise<TeamRecord> {
    const team: TeamRecord = { ...input, createdAt: new Date().toISOString() };
    this.teams.set(team.id, team);
    return team;
  }

  async getTeam(id: string): Promise<TeamRecord | null> {
    return this.teams.get(id) ?? null;
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    const memberOf = new Set([...this.teamMembers.values()].filter((m) => m.userId === userId).map((m) => m.teamId));
    return [...this.teams.values()].filter((t) => t.ownerId === userId || memberOf.has(t.id));
  }

  async deleteTeam(id: string): Promise<void> {
    for (const [key, m] of this.teamMembers) if (m.teamId === id) this.teamMembers.delete(key);
    // Detach the team's servers so they stay reachable by their owner.
    for (const [key, c] of this.configs) if (c.teamId === id) this.configs.set(key, { ...c, teamId: null });
    this.teams.delete(id);
  }

  async addTeamMember(input: { teamId: string; userId: string; role: string }): Promise<TeamMemberRecord> {
    const existing = [...this.teamMembers.values()].find((m) => m.teamId === input.teamId && m.userId === input.userId);
    const member: TeamMemberRecord = {
      id: existing?.id ?? randomUUID(),
      ...input,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.teamMembers.set(member.id, member);
    return member;
  }

  async listTeamMembers(teamId: string): Promise<TeamMemberView[]> {
    return [...this.teamMembers.values()]
      .filter((m) => m.teamId === teamId)
      .map((m) => {
        const user = this.users.get(m.userId);
        return { ...m, email: user?.email ?? '', displayName: user?.displayName ?? m.userId };
      });
  }

  async getTeamMember(teamId: string, userId: string): Promise<TeamMemberRecord | null> {
    return [...this.teamMembers.values()].find((m) => m.teamId === teamId && m.userId === userId) ?? null;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    for (const [key, m] of this.teamMembers) if (m.teamId === teamId && m.userId === userId) this.teamMembers.delete(key);
  }

  async setServerTeam(serverConfigId: string, teamId: string | null): Promise<void> {
    const config = this.configs.get(serverConfigId);
    if (config) this.configs.set(serverConfigId, { ...config, teamId });
  }

  async upsertNode(input: UpsertNodeInput): Promise<NodeRecord> {
    const existing = this.nodes.get(input.id);
    const node: NodeRecord = {
      id: input.id,
      name: input.name ?? existing?.name ?? input.id,
      location: input.location !== undefined ? input.location : (existing?.location ?? null),
      ipAddress: input.ipAddress ?? existing?.ipAddress ?? null,
      agentUrl: input.agentUrl ?? existing?.agentUrl ?? null,
      lastHeartbeat: input.lastHeartbeat,
      cpuPercent: input.cpuPercent ?? existing?.cpuPercent ?? null,
      ramUsedMb: input.ramUsedMb ?? existing?.ramUsedMb ?? null,
      ramTotalMb: input.ramTotalMb ?? existing?.ramTotalMb ?? null,
      diskUsedGb: input.diskUsedGb ?? existing?.diskUsedGb ?? null,
      diskTotalGb: input.diskTotalGb ?? existing?.diskTotalGb ?? null,
      // Maintenance is an administrator's decision; a liveness beat never touches
      // it, or the node would silently re-enter the pool a second later (#258).
      maintenance: existing?.maintenance ?? false,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  async listNodes(): Promise<NodeRecord[]> {
    return Array.from(this.nodes.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async registerNode(input: RegisterNodeInput): Promise<NodeRecord> {
    const existing = this.nodes.get(input.id);
    const node: NodeRecord = existing
      ? {
          ...existing,
          name: input.name ?? existing.name,
          location: input.location !== undefined ? input.location : existing.location,
          agentUrl: input.agentUrl !== undefined ? input.agentUrl : existing.agentUrl,
          maintenance: input.maintenance !== undefined ? input.maintenance : existing.maintenance,
        }
      : {
          id: input.id,
          name: input.name ?? input.id,
          location: input.location ?? null,
          ipAddress: null,
          agentUrl: input.agentUrl ?? null,
          // Registered-but-unseen → epoch so it reads offline until its agent beats.
          lastHeartbeat: new Date(0).toISOString(),
          cpuPercent: null,
          ramUsedMb: null,
          ramTotalMb: null,
          diskUsedGb: null,
          diskTotalGb: null,
          maintenance: input.maintenance ?? false,
        };
    this.nodes.set(node.id, node);
    return node;
  }

  async deleteNode(id: string): Promise<void> {
    // Detach the node from any deployments so the record can be removed cleanly.
    for (const [depId, d] of this.deployments) {
      if (d.nodeId === id) this.deployments.set(depId, { ...d, nodeId: null });
    }
    this.nodes.delete(id);
  }

  async createServerConfig(input: CreateServerConfigInput): Promise<ServerConfigRecord> {
    const config: ServerConfigRecord = {
      id: randomUUID(),
      userId: input.userId,
      teamId: input.teamId ?? null,
      name: input.name,
      dockerImage: input.dockerImage,
      ports: input.ports ?? {},
      env: input.env ?? {},
      resourceLimits: input.resourceLimits ?? {},
      autoRestart: input.autoRestart ?? false,
      type: input.type ?? 'generic',
      createdAt: new Date().toISOString(),
    };
    this.configs.set(config.id, config);
    return config;
  }

  async createDeployment(serverConfigId: string, nodeId: string | null): Promise<DeploymentRecord> {
    const deployment: DeploymentRecord = {
      id: randomUUID(),
      serverConfigId,
      nodeId,
      containerId: null,
      status: 'pending',
      startedAt: null,
      stoppedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.deployments.set(deployment.id, deployment);
    return deployment;
  }

  async updateDeploymentStatus(id: string, patch: DeploymentStatusPatch): Promise<DeploymentRecord | null> {
    const current = this.deployments.get(id);
    if (!current) return null;
    const updated: DeploymentRecord = {
      ...current,
      status: patch.status ?? current.status,
      nodeId: patch.nodeId !== undefined ? patch.nodeId : current.nodeId,
      containerId: patch.containerId !== undefined ? patch.containerId : current.containerId,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
      stoppedAt: patch.stoppedAt !== undefined ? patch.stoppedAt : current.stoppedAt,
    };
    this.deployments.set(id, updated);
    return updated;
  }

  async appendDeploymentEvent(deploymentId: string, event: string, message: string): Promise<void> {
    this.events.push({
      id: randomUUID(),
      deploymentId,
      event,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  async listDeployments(): Promise<DeploymentView[]> {
    return Array.from(this.deployments.values())
      .map((d) => this.toView(d))
      .filter((v): v is DeploymentView => v !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listDeploymentsForUser(user: { id: string; email: string }): Promise<DeploymentView[]> {
    // Only active shares — a pending invitation grants nothing yet (#176).
    const sharedWith = new Set(
      [...this.subusers.values()].filter((s) => s.userId === user.id && s.status === 'active').map((s) => s.deploymentId)
    );
    // Plus everything shared with a team they belong to (#177).
    const myTeams = new Set([...this.teamMembers.values()].filter((m) => m.userId === user.id).map((m) => m.teamId));
    return (await this.listDeployments()).filter(
      (d) => d.userId === user.id || sharedWith.has(d.id) || (d.teamId !== null && myTeams.has(d.teamId))
    );
  }

  async getDeployment(id: string): Promise<DeploymentDetail | null> {
    const deployment = this.deployments.get(id);
    if (!deployment) return null;
    const view = this.toView(deployment);
    const config = this.configs.get(deployment.serverConfigId);
    if (!view || !config) return null;
    const events = this.events
      .filter((e) => e.deploymentId === id)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return {
      ...view,
      events,
      ports: config.ports,
      env: config.env,
      resourceLimits: config.resourceLimits,
      autoRestart: config.autoRestart,
    };
  }

  async deleteDeployment(id: string): Promise<void> {
    const deployment = this.deployments.get(id);
    if (!deployment) return;
    // Drop child records first, then the deployment and its (now-orphan) config.
    this.events = this.events.filter((e) => e.deploymentId !== id);
    for (const [key, d] of this.databases) if (d.deploymentId === id) this.databases.delete(key);
    for (const [key, b] of this.backups) if (b.deploymentId === id) this.backups.delete(key);
    for (const [key, s] of this.schedules) if (s.deploymentId === id) this.schedules.delete(key);
    for (const [key, su] of this.subusers) if (su.deploymentId === id) this.subusers.delete(key);
    this.deployments.delete(id);
    this.configs.delete(deployment.serverConfigId);
  }

  async getDeploymentConfig(deploymentId: string): Promise<ServerConfigRecord | null> {
    const deployment = this.deployments.get(deploymentId);
    if (!deployment) return null;
    return this.configs.get(deployment.serverConfigId) ?? null;
  }

  async createDatabase(input: CreateServerDatabaseInput): Promise<ServerDatabaseRecord> {
    const db: ServerDatabaseRecord = {
      id: randomUUID(),
      deploymentId: input.deploymentId,
      engine: input.engine,
      name: input.name,
      username: input.username,
      password: input.password,
      host: input.host,
      port: input.port,
      containerId: input.containerId,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    this.databases.set(db.id, db);
    return db;
  }

  async listDatabases(deploymentId: string): Promise<ServerDatabaseRecord[]> {
    return Array.from(this.databases.values())
      .filter((d) => d.deploymentId === deploymentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getDatabase(id: string): Promise<ServerDatabaseRecord | null> {
    return this.databases.get(id) ?? null;
  }

  async deleteDatabase(id: string): Promise<void> {
    this.databases.delete(id);
  }

  async createBackup(input: CreateServerBackupInput): Promise<ServerBackupRecord> {
    const backup: ServerBackupRecord = {
      id: randomUUID(),
      deploymentId: input.deploymentId,
      name: input.name,
      path: input.path,
      ref: input.ref,
      sizeBytes: input.sizeBytes,
      status: 'ready',
      createdAt: new Date().toISOString(),
    };
    this.backups.set(backup.id, backup);
    return backup;
  }

  async listBackups(deploymentId: string): Promise<ServerBackupRecord[]> {
    return Array.from(this.backups.values())
      .filter((b) => b.deploymentId === deploymentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getBackup(id: string): Promise<ServerBackupRecord | null> {
    return this.backups.get(id) ?? null;
  }

  async deleteBackup(id: string): Promise<void> {
    this.backups.delete(id);
  }

  async createSchedule(input: CreateServerScheduleInput): Promise<ServerScheduleRecord> {
    const schedule: ServerScheduleRecord = {
      id: randomUUID(),
      deploymentId: input.deploymentId,
      name: input.name,
      cron: input.cron,
      action: input.action,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      createdAt: new Date().toISOString(),
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async listSchedules(deploymentId: string): Promise<ServerScheduleRecord[]> {
    return Array.from(this.schedules.values())
      .filter((s) => s.deploymentId === deploymentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listAllSchedules(): Promise<ServerScheduleRecord[]> {
    return Array.from(this.schedules.values());
  }

  async getSchedule(id: string): Promise<ServerScheduleRecord | null> {
    return this.schedules.get(id) ?? null;
  }

  async updateSchedule(id: string, patch: UpdateServerScheduleInput): Promise<ServerScheduleRecord | null> {
    const current = this.schedules.get(id);
    if (!current) return null;
    const updated: ServerScheduleRecord = {
      ...current,
      name: patch.name ?? current.name,
      cron: patch.cron ?? current.cron,
      action: patch.action ?? current.action,
      enabled: patch.enabled ?? current.enabled,
      lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : current.lastRunAt,
    };
    this.schedules.set(id, updated);
    return updated;
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules.delete(id);
  }

  async createSubuser(input: CreateServerSubuserInput): Promise<ServerSubuserRecord> {
    // One row per (deployment, email): re-inviting updates the role.
    const existing = Array.from(this.subusers.values()).find((s) => s.deploymentId === input.deploymentId && s.email === input.email);
    const su: ServerSubuserRecord = {
      id: existing?.id ?? randomUUID(),
      deploymentId: input.deploymentId,
      email: input.email,
      // Re-inviting must not un-bind an already-accepted share.
      userId: input.userId ?? existing?.userId ?? null,
      status: input.status ?? existing?.status ?? 'pending',
      role: input.role,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.subusers.set(su.id, su);
    return su;
  }

  async listSubusers(deploymentId: string): Promise<ServerSubuserRecord[]> {
    return Array.from(this.subusers.values())
      .filter((s) => s.deploymentId === deploymentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSubuser(id: string): Promise<ServerSubuserRecord | null> {
    return this.subusers.get(id) ?? null;
  }

  async getSubuserFor(deploymentId: string, email: string): Promise<ServerSubuserRecord | null> {
    return [...this.subusers.values()].find((s) => s.deploymentId === deploymentId && s.email === email) ?? null;
  }

  async claimSubuserInvites(userId: string, email: string): Promise<number> {
    let claimed = 0;
    for (const [id, s] of this.subusers) {
      if (s.email !== email || s.status === 'active') continue;
      this.subusers.set(id, { ...s, userId, status: 'active' });
      claimed += 1;
    }
    return claimed;
  }

  async updateSubuserRole(id: string, role: string): Promise<ServerSubuserRecord | null> {
    const current = this.subusers.get(id);
    if (!current) return null;
    const updated = { ...current, role };
    this.subusers.set(id, updated);
    return updated;
  }

  async deleteSubuser(id: string): Promise<void> {
    this.subusers.delete(id);
  }

  private toView(d: DeploymentRecord): DeploymentView | null {
    const config = this.configs.get(d.serverConfigId);
    if (!config) return null;
    return { ...d, name: config.name, dockerImage: config.dockerImage, userId: config.userId, teamId: config.teamId, type: config.type };
  }
}
