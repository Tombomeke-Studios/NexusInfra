import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type {
  CreateServerConfigInput,
  DeploymentDetail,
  DeploymentRecord,
  DeploymentStatus,
  DeploymentStatusPatch,
  DeploymentView,
  CreateServerBackupInput,
  CreateServerDatabaseInput,
  CreateServerScheduleInput,
  CreateServerSubuserInput,
  NodeRecord,
  RegisterNodeInput,
  Repository,
  ResourceLimits,
  ServerBackupRecord,
  ServerConfigRecord,
  ServerDatabaseRecord,
  ServerScheduleRecord,
  ServerSubuserRecord,
  UpdateServerScheduleInput,
  UpsertNodeInput,
} from './types.js';

// Prisma-backed Repository (SQLite). The mapping helpers below convert between
// Prisma's row shape (Date objects, serialized JSON strings) and the plain domain
// records the rest of the Orchestrator works with.

let prisma: PrismaClient | null = null;

/** Lazily-created Prisma client singleton. */
export function getPrisma(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

type PrismaNode = Awaited<ReturnType<PrismaClient['node']['findFirstOrThrow']>>;
type PrismaConfig = Awaited<ReturnType<PrismaClient['serverConfig']['findFirstOrThrow']>>;
type PrismaDeployment = Awaited<ReturnType<PrismaClient['deployment']['findFirstOrThrow']>>;
type PrismaDatabase = Awaited<ReturnType<PrismaClient['serverDatabase']['findFirstOrThrow']>>;
type PrismaBackup = Awaited<ReturnType<PrismaClient['serverBackup']['findFirstOrThrow']>>;
type PrismaSchedule = Awaited<ReturnType<PrismaClient['serverSchedule']['findFirstOrThrow']>>;
type PrismaSubuser = Awaited<ReturnType<PrismaClient['serverSubuser']['findFirstOrThrow']>>;

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function parseJson(value: string): Record<string, string> {
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

function parseLimits(value: string): ResourceLimits {
  try {
    const parsed = JSON.parse(value) as ResourceLimits;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toNodeRecord(n: PrismaNode): NodeRecord {
  return {
    id: n.id,
    name: n.name,
    location: n.location,
    ipAddress: n.ipAddress,
    lastHeartbeat: n.lastHeartbeat.toISOString(),
    cpuPercent: n.cpuPercent,
    ramUsedMb: n.ramUsedMb,
    ramTotalMb: n.ramTotalMb,
    diskUsedGb: n.diskUsedGb,
    diskTotalGb: n.diskTotalGb,
  };
}

function toConfigRecord(c: PrismaConfig): ServerConfigRecord {
  return {
    id: c.id,
    userId: c.userId,
    name: c.name,
    dockerImage: c.dockerImage,
    ports: parseJson(c.ports),
    env: parseJson(c.environmentVars),
    resourceLimits: parseLimits(c.resourceLimits),
    autoRestart: c.autoRestart,
    type: c.type,
    createdAt: c.createdAt.toISOString(),
  };
}

function toDatabaseRecord(d: PrismaDatabase): ServerDatabaseRecord {
  return {
    id: d.id,
    deploymentId: d.deploymentId,
    engine: d.engine,
    name: d.name,
    username: d.username,
    password: d.password,
    host: d.host,
    port: d.port,
    containerId: d.containerId,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
  };
}

function toBackupRecord(b: PrismaBackup): ServerBackupRecord {
  return {
    id: b.id,
    deploymentId: b.deploymentId,
    name: b.name,
    path: b.path,
    ref: b.ref,
    sizeBytes: b.sizeBytes,
    status: b.status,
    createdAt: b.createdAt.toISOString(),
  };
}

function toScheduleRecord(s: PrismaSchedule): ServerScheduleRecord {
  return {
    id: s.id,
    deploymentId: s.deploymentId,
    name: s.name,
    cron: s.cron,
    action: s.action,
    enabled: s.enabled,
    lastRunAt: iso(s.lastRunAt),
    createdAt: s.createdAt.toISOString(),
  };
}

function toSubuserRecord(s: PrismaSubuser): ServerSubuserRecord {
  return {
    id: s.id,
    deploymentId: s.deploymentId,
    email: s.email,
    role: s.role,
    createdAt: s.createdAt.toISOString(),
  };
}

function toDeploymentRecord(d: PrismaDeployment): DeploymentRecord {
  return {
    id: d.id,
    serverConfigId: d.serverConfigId,
    nodeId: d.nodeId,
    containerId: d.containerId,
    status: d.status as DeploymentStatus,
    startedAt: iso(d.startedAt),
    stoppedAt: iso(d.stoppedAt),
    createdAt: d.createdAt.toISOString(),
  };
}

export class PrismaRepository implements Repository {
  constructor(private readonly client: PrismaClient = getPrisma()) {}

  async upsertNode(input: UpsertNodeInput): Promise<NodeRecord> {
    // Undefined fields mean "preserve": liveness-only heartbeats (every 1s) omit
    // resources, which arrive only every 5s — so we must not null them out on the
    // in-between beats. Only keys explicitly provided are written on update.
    const provided = <T>(v: T | undefined): v is T => v !== undefined;
    const update = {
      lastHeartbeat: new Date(input.lastHeartbeat),
      ...(provided(input.name) ? { name: input.name } : {}),
      ...(provided(input.location) ? { location: input.location } : {}),
      ...(provided(input.ipAddress) ? { ipAddress: input.ipAddress } : {}),
      ...(provided(input.cpuPercent) ? { cpuPercent: input.cpuPercent } : {}),
      ...(provided(input.ramUsedMb) ? { ramUsedMb: input.ramUsedMb } : {}),
      ...(provided(input.ramTotalMb) ? { ramTotalMb: input.ramTotalMb } : {}),
      ...(provided(input.diskUsedGb) ? { diskUsedGb: input.diskUsedGb } : {}),
      ...(provided(input.diskTotalGb) ? { diskTotalGb: input.diskTotalGb } : {}),
    };
    const node = await this.client.node.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        name: input.name ?? input.id,
        location: input.location ?? null,
        ipAddress: input.ipAddress ?? null,
        lastHeartbeat: new Date(input.lastHeartbeat),
        cpuPercent: input.cpuPercent ?? null,
        ramUsedMb: input.ramUsedMb ?? null,
        ramTotalMb: input.ramTotalMb ?? null,
        diskUsedGb: input.diskUsedGb ?? null,
        diskTotalGb: input.diskTotalGb ?? null,
      },
      update,
    });
    return toNodeRecord(node);
  }

  async listNodes(): Promise<NodeRecord[]> {
    const nodes = await this.client.node.findMany({ orderBy: { id: 'asc' } });
    return nodes.map(toNodeRecord);
  }

  async registerNode(input: RegisterNodeInput): Promise<NodeRecord> {
    const node = await this.client.node.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        name: input.name ?? input.id,
        location: input.location ?? null,
        // Registered-but-unseen → epoch so it reads offline until its agent beats.
        lastHeartbeat: new Date(0),
      },
      update: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
      },
    });
    return toNodeRecord(node);
  }

  async deleteNode(id: string): Promise<void> {
    // Detach deployments first so the FK doesn't block the delete.
    await this.client.deployment.updateMany({ where: { nodeId: id }, data: { nodeId: null } });
    await this.client.node.delete({ where: { id } });
  }

  async createServerConfig(input: CreateServerConfigInput): Promise<ServerConfigRecord> {
    const config = await this.client.serverConfig.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        name: input.name,
        dockerImage: input.dockerImage,
        ports: JSON.stringify(input.ports ?? {}),
        environmentVars: JSON.stringify(input.env ?? {}),
        resourceLimits: JSON.stringify(input.resourceLimits ?? {}),
        autoRestart: input.autoRestart ?? false,
        type: input.type ?? 'generic',
      },
    });
    return toConfigRecord(config);
  }

  async createDeployment(serverConfigId: string, nodeId: string | null): Promise<DeploymentRecord> {
    const deployment = await this.client.deployment.create({
      data: { id: randomUUID(), serverConfigId, nodeId, status: 'pending' },
    });
    return toDeploymentRecord(deployment);
  }

  async updateDeploymentStatus(id: string, patch: DeploymentStatusPatch): Promise<DeploymentRecord | null> {
    const exists = await this.client.deployment.findUnique({ where: { id } });
    if (!exists) return null;
    const deployment = await this.client.deployment.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.nodeId !== undefined ? { nodeId: patch.nodeId } : {}),
        ...(patch.containerId !== undefined ? { containerId: patch.containerId } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt ? new Date(patch.startedAt) : null } : {}),
        ...(patch.stoppedAt !== undefined ? { stoppedAt: patch.stoppedAt ? new Date(patch.stoppedAt) : null } : {}),
      },
    });
    return toDeploymentRecord(deployment);
  }

  async appendDeploymentEvent(deploymentId: string, event: string, message: string): Promise<void> {
    await this.client.deploymentEvent.create({
      data: { id: randomUUID(), deploymentId, event, message },
    });
  }

  async listDeployments(): Promise<DeploymentView[]> {
    const rows = await this.client.deployment.findMany({
      include: { serverConfig: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((d) => ({
      ...toDeploymentRecord(d),
      name: d.serverConfig.name,
      dockerImage: d.serverConfig.dockerImage,
      userId: d.serverConfig.userId,
      type: d.serverConfig.type,
    }));
  }

  async getDeploymentConfig(deploymentId: string): Promise<ServerConfigRecord | null> {
    const d = await this.client.deployment.findUnique({
      where: { id: deploymentId },
      include: { serverConfig: true },
    });
    return d ? toConfigRecord(d.serverConfig) : null;
  }

  async deleteDeployment(id: string): Promise<void> {
    const deployment = await this.client.deployment.findUnique({ where: { id } });
    if (!deployment) return;
    // Remove child rows first (FKs have no cascade), then the deployment and its
    // now-orphan server config.
    await this.client.deploymentEvent.deleteMany({ where: { deploymentId: id } });
    await this.client.serverDatabase.deleteMany({ where: { deploymentId: id } });
    await this.client.serverBackup.deleteMany({ where: { deploymentId: id } });
    await this.client.serverSchedule.deleteMany({ where: { deploymentId: id } });
    await this.client.serverSubuser.deleteMany({ where: { deploymentId: id } });
    await this.client.deployment.delete({ where: { id } });
    await this.client.serverConfig.delete({ where: { id: deployment.serverConfigId } }).catch(() => {
      // Config may be shared/already gone; ignore.
    });
  }

  async createDatabase(input: CreateServerDatabaseInput): Promise<ServerDatabaseRecord> {
    const db = await this.client.serverDatabase.create({ data: { id: randomUUID(), ...input } });
    return toDatabaseRecord(db);
  }

  async listDatabases(deploymentId: string): Promise<ServerDatabaseRecord[]> {
    const rows = await this.client.serverDatabase.findMany({ where: { deploymentId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toDatabaseRecord);
  }

  async getDatabase(id: string): Promise<ServerDatabaseRecord | null> {
    const db = await this.client.serverDatabase.findUnique({ where: { id } });
    return db ? toDatabaseRecord(db) : null;
  }

  async deleteDatabase(id: string): Promise<void> {
    await this.client.serverDatabase.delete({ where: { id } });
  }

  async createBackup(input: CreateServerBackupInput): Promise<ServerBackupRecord> {
    const backup = await this.client.serverBackup.create({ data: { id: randomUUID(), ...input } });
    return toBackupRecord(backup);
  }

  async listBackups(deploymentId: string): Promise<ServerBackupRecord[]> {
    const rows = await this.client.serverBackup.findMany({ where: { deploymentId }, orderBy: { createdAt: 'desc' } });
    return rows.map(toBackupRecord);
  }

  async getBackup(id: string): Promise<ServerBackupRecord | null> {
    const b = await this.client.serverBackup.findUnique({ where: { id } });
    return b ? toBackupRecord(b) : null;
  }

  async deleteBackup(id: string): Promise<void> {
    await this.client.serverBackup.delete({ where: { id } });
  }

  async createSchedule(input: CreateServerScheduleInput): Promise<ServerScheduleRecord> {
    const s = await this.client.serverSchedule.create({ data: { id: randomUUID(), ...input } });
    return toScheduleRecord(s);
  }

  async listSchedules(deploymentId: string): Promise<ServerScheduleRecord[]> {
    const rows = await this.client.serverSchedule.findMany({ where: { deploymentId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toScheduleRecord);
  }

  async listAllSchedules(): Promise<ServerScheduleRecord[]> {
    const rows = await this.client.serverSchedule.findMany();
    return rows.map(toScheduleRecord);
  }

  async getSchedule(id: string): Promise<ServerScheduleRecord | null> {
    const s = await this.client.serverSchedule.findUnique({ where: { id } });
    return s ? toScheduleRecord(s) : null;
  }

  async updateSchedule(id: string, patch: UpdateServerScheduleInput): Promise<ServerScheduleRecord | null> {
    const exists = await this.client.serverSchedule.findUnique({ where: { id } });
    if (!exists) return null;
    const s = await this.client.serverSchedule.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
        ...(patch.action !== undefined ? { action: patch.action } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt ? new Date(patch.lastRunAt) : null } : {}),
      },
    });
    return toScheduleRecord(s);
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.client.serverSchedule.delete({ where: { id } });
  }

  async createSubuser(input: CreateServerSubuserInput): Promise<ServerSubuserRecord> {
    // Upsert on the (deployment, email) unique key: re-inviting updates the role.
    const s = await this.client.serverSubuser.upsert({
      where: { deploymentId_email: { deploymentId: input.deploymentId, email: input.email } },
      create: { id: randomUUID(), deploymentId: input.deploymentId, email: input.email, role: input.role },
      update: { role: input.role },
    });
    return toSubuserRecord(s);
  }

  async listSubusers(deploymentId: string): Promise<ServerSubuserRecord[]> {
    const rows = await this.client.serverSubuser.findMany({ where: { deploymentId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toSubuserRecord);
  }

  async getSubuser(id: string): Promise<ServerSubuserRecord | null> {
    const s = await this.client.serverSubuser.findUnique({ where: { id } });
    return s ? toSubuserRecord(s) : null;
  }

  async updateSubuserRole(id: string, role: string): Promise<ServerSubuserRecord | null> {
    const exists = await this.client.serverSubuser.findUnique({ where: { id } });
    if (!exists) return null;
    const s = await this.client.serverSubuser.update({ where: { id }, data: { role } });
    return toSubuserRecord(s);
  }

  async deleteSubuser(id: string): Promise<void> {
    await this.client.serverSubuser.delete({ where: { id } });
  }

  async getDeployment(id: string): Promise<DeploymentDetail | null> {
    const d = await this.client.deployment.findUnique({
      where: { id },
      include: { serverConfig: true, events: { orderBy: { timestamp: 'asc' } } },
    });
    if (!d) return null;
    return {
      ...toDeploymentRecord(d),
      name: d.serverConfig.name,
      dockerImage: d.serverConfig.dockerImage,
      userId: d.serverConfig.userId,
      type: d.serverConfig.type,
      events: d.events.map((e) => ({
        id: e.id,
        deploymentId: e.deploymentId,
        event: e.event,
        message: e.message,
        timestamp: e.timestamp.toISOString(),
      })),
    };
  }
}
