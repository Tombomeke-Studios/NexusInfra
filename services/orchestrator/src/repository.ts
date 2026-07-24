import { randomUUID } from 'crypto';
import type {
  CreateServerConfigInput,
  CreateServerDatabaseInput,
  DeploymentDetail,
  DeploymentEventRecord,
  DeploymentRecord,
  DeploymentStatusPatch,
  DeploymentView,
  NodeRecord,
  Repository,
  ServerConfigRecord,
  ServerDatabaseRecord,
  UpsertNodeInput,
} from './types.js';

/**
 * In-memory Repository implementation.
 *
 * Used by unit tests (no database needed) and as a DB-less fallback for local
 * development. Behaviour must match PrismaRepository (db.ts) — the shared
 * contract test exercises this implementation.
 */
export class InMemoryRepository implements Repository {
  private nodes = new Map<string, NodeRecord>();
  private configs = new Map<string, ServerConfigRecord>();
  private deployments = new Map<string, DeploymentRecord>();
  private events: DeploymentEventRecord[] = [];
  private databases = new Map<string, ServerDatabaseRecord>();

  async upsertNode(input: UpsertNodeInput): Promise<NodeRecord> {
    const existing = this.nodes.get(input.id);
    const node: NodeRecord = {
      id: input.id,
      name: input.name ?? existing?.name ?? input.id,
      ipAddress: input.ipAddress ?? existing?.ipAddress ?? null,
      lastHeartbeat: input.lastHeartbeat,
      cpuPercent: input.cpuPercent ?? existing?.cpuPercent ?? null,
      ramUsedMb: input.ramUsedMb ?? existing?.ramUsedMb ?? null,
      ramTotalMb: input.ramTotalMb ?? existing?.ramTotalMb ?? null,
      diskUsedGb: input.diskUsedGb ?? existing?.diskUsedGb ?? null,
      diskTotalGb: input.diskTotalGb ?? existing?.diskTotalGb ?? null,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  async listNodes(): Promise<NodeRecord[]> {
    return Array.from(this.nodes.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async createServerConfig(input: CreateServerConfigInput): Promise<ServerConfigRecord> {
    const config: ServerConfigRecord = {
      id: randomUUID(),
      userId: input.userId,
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

  async getDeployment(id: string): Promise<DeploymentDetail | null> {
    const deployment = this.deployments.get(id);
    if (!deployment) return null;
    const view = this.toView(deployment);
    if (!view) return null;
    const events = this.events
      .filter((e) => e.deploymentId === id)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return { ...view, events };
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

  private toView(d: DeploymentRecord): DeploymentView | null {
    const config = this.configs.get(d.serverConfigId);
    if (!config) return null;
    return { ...d, name: config.name, dockerImage: config.dockerImage, userId: config.userId };
  }
}
