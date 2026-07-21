import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type {
  CreateServerConfigInput,
  DeploymentDetail,
  DeploymentRecord,
  DeploymentStatus,
  DeploymentStatusPatch,
  DeploymentView,
  NodeRecord,
  Repository,
  ServerConfigRecord,
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

function toNodeRecord(n: PrismaNode): NodeRecord {
  return {
    id: n.id,
    name: n.name,
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
    autoRestart: c.autoRestart,
    type: c.type,
    createdAt: c.createdAt.toISOString(),
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

  async createServerConfig(input: CreateServerConfigInput): Promise<ServerConfigRecord> {
    const config = await this.client.serverConfig.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        name: input.name,
        dockerImage: input.dockerImage,
        ports: JSON.stringify(input.ports ?? {}),
        environmentVars: JSON.stringify(input.env ?? {}),
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
    }));
  }

  async getDeploymentConfig(deploymentId: string): Promise<ServerConfigRecord | null> {
    const d = await this.client.deployment.findUnique({
      where: { id: deploymentId },
      include: { serverConfig: true },
    });
    return d ? toConfigRecord(d.serverConfig) : null;
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
