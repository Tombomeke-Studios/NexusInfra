import { Router, raw, type Request, type Response } from 'express';
import { buildEnvelope, getInternalToken, INTERNAL_TOKEN_HEADER, isHosted, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent } from 'shared';
import { nodeHealth } from './nodeRegistry.js';
import { selectNode as defaultSelectNode } from './nodeSelection.js';
import { generateDatabaseCredentials, isDatabaseEngine } from './dbProvision.js';
import { isValidCron } from './cron.js';
import { runScheduleAction, type ScheduleActions } from './scheduler.js';
import { resolveAgentUrl } from './agentUrl.js';
import { principalOf, requirePlatformAdmin } from './auth.js';
import { accessGuard, accessOf, requirePermission } from './accessGuard.js';
import { isGrantableRole, resolveRole } from './access.js';
import { createServerTeamRouter } from './teams.js';
import { EGGS, getEgg, buildEggDeployment, EggValidationError } from './eggs.js';
import { containerMemoryMb, heapBudgetProblem, parseMemoryMb } from './memory.js';
import type { DeploymentDetail, NodeRecord, Repository, ServerConfigRecord, UpdateServerConfigInput } from './types.js';
import type { ResourceLimits } from 'shared';

const SCHEDULE_ACTIONS = ['restart', 'backup'];

// Cap on a single file upload; the body is buffered here and again in the agent,
// so an unbounded upload is an out-of-memory crash rather than a slow request.
const MAX_UPLOAD_BYTES = process.env.MAX_UPLOAD_BYTES || '64mb';
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// Short id suffix for an auto-generated node id (not security-sensitive).
const randomToken = () => Math.random().toString(36).slice(2, 8);

// Where the (single, local) Node Agent's internal HTTP lives. Multi-node will
// resolve this per node from the registry.
const NODE_AGENT_URL = process.env.NODE_AGENT_URL || 'http://node-agent:9100';

/**
 * Call the Node Agent's internal API, attaching the shared internal token (#169).
 * Every orchestrator → agent request must go through this; a bare `fetch` would be
 * rejected with 401.
 */
export function agentFetch(url: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), [INTERNAL_TOKEN_HEADER]: getInternalToken() },
  });
}

// Where the Billing Bridge's internal HTTP lives (hosted edition only).
const BILLING_BRIDGE_URL = process.env.BILLING_BRIDGE_URL || 'http://billing-bridge:9300';

/** Decide whether a deployment's container can be streamed from, and which one. */
export function resolveContainerTarget(detail: DeploymentDetail | null): { status: number; error?: string; containerId?: string } {
  if (!detail) return { status: 404, error: 'deployment not found' };
  if (!detail.containerId) return { status: 409, error: 'deployment is not running' };
  return { status: 200, containerId: detail.containerId };
}

// Deployment REST API — the user-facing entry point that turns a server config
// into a running container. Creating a deployment picks a node and emits
// infra.server.start; the Node Agent runs the container and reports back (handled
// by lifecycle.ts).
//
// Authentication (who is calling) comes from auth.ts; authorization (what they
// may do to this server) from accessGuard.ts. Every route under
// /deployments/:id sits behind the guard and declares the permission it needs.

const KEY_START = 'infra.server.start';
const KEY_STOP = 'infra.server.stop';
const KEY_KILL = 'infra.server.kill';
const KEY_RESTART = 'infra.server.restart';

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;
export type SelectNodeFn = (nodes: NodeRecord[], now: number) => NodeRecord | null;

// Each of these talks to a specific node's agent, so they take that node's
// `agentUrl` — resolved from the owning deployment (#171).
/** Provisions a database container on the owning Node Agent; returns its id + host port. */
export type ProvisionDatabaseFn = (req: { agentUrl: string; engine: string; name: string; username: string; password: string }) => Promise<{ containerId: string; port: number }>;
export type DeprovisionDatabaseFn = (agentUrl: string, containerId: string) => Promise<void>;

/** Snapshot / restore / delete a container backup on the owning Node Agent. */
export type SnapshotBackupFn = (req: { agentUrl: string; containerId: string; path?: string }) => Promise<{ ref: string; sizeBytes: number; path: string }>;
export type RestoreBackupFn = (req: { agentUrl: string; containerId: string; ref: string; path: string }) => Promise<void>;
export type RemoveBackupFn = (agentUrl: string, ref: string) => Promise<void>;

/** Plan-quota check against the Billing Bridge (hosted). Fails open so billing outages never block infra. */
export type QuotaResource = 'servers' | 'databases';
export type CheckQuotaFn = (userId: string, resource: QuotaResource, current: number) => Promise<{ allowed: boolean; limit: number }>;

export interface ApiDeps {
  repo: Repository;
  publish?: PublishFn;
  selectNode?: SelectNodeFn;
  provisionDatabase?: ProvisionDatabaseFn;
  deprovisionDatabase?: DeprovisionDatabaseFn;
  snapshotBackup?: SnapshotBackupFn;
  restoreBackup?: RestoreBackupFn;
  removeBackup?: RemoveBackupFn;
  scheduleActions?: ScheduleActions;
  checkQuota?: CheckQuotaFn;
}

// Default quota check: in the community edition everything is allowed (no
// billing); in hosted it asks the Billing Bridge. If the bridge is unreachable
// or errors we fail open — a billing outage must not stop people deploying.
const defaultCheckQuota: CheckQuotaFn = async (userId, resource, current) => {
  if (!isHosted()) return { allowed: true, limit: Infinity };
  try {
    const r = await fetch(`${BILLING_BRIDGE_URL}/billing/${userId}/quota?resource=${resource}&current=${current}`);
    if (!r.ok) return { allowed: true, limit: Infinity };
    return (await r.json()) as { allowed: boolean; limit: number };
  } catch {
    return { allowed: true, limit: Infinity };
  }
};

const noopScheduleActions: ScheduleActions = { restart: async () => {}, backup: async () => {} };

// Default provisioning talks to the Node Agent's internal database HTTP.
const defaultProvisionDatabase: ProvisionDatabaseFn = async ({ agentUrl, ...spec }) => {
  const r = await agentFetch(`${agentUrl}/databases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'database provisioning failed');
  return (await r.json()) as { containerId: string; port: number };
};

const defaultDeprovisionDatabase: DeprovisionDatabaseFn = async (agentUrl, containerId) => {
  await agentFetch(`${agentUrl}/databases/${containerId}`, { method: 'DELETE' });
};

const DB_PUBLIC_HOST = process.env.DATABASE_PUBLIC_HOST || 'localhost';

const defaultSnapshotBackup: SnapshotBackupFn = async ({ agentUrl, ...spec }) => {
  const r = await agentFetch(`${agentUrl}/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'backup failed');
  return (await r.json()) as { ref: string; sizeBytes: number; path: string };
};

const defaultRestoreBackup: RestoreBackupFn = async ({ agentUrl, ...spec }) => {
  const r = await agentFetch(`${agentUrl}/backups/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'restore failed');
};

const defaultRemoveBackup: RemoveBackupFn = async (agentUrl, ref) => {
  await agentFetch(`${agentUrl}/backups/${ref}`, { method: 'DELETE' });
};

/**
 * The bind mount a server needs at start, if it imported a directory (#268).
 *
 * Where it mounts comes from the egg rather than a stored copy, so a server always
 * follows the catalogue rather than a value frozen when it was created.
 */
/**
 * Why this server's heap will not fit its memory cap, or null when it does (#271).
 *
 * Silent when anything is unknown: no cap set, a node that has not reported its
 * RAM, an egg with no heap variable, or a value that is not a memory size. A
 * guess would refuse valid configurations, and this is a hard failure path.
 */
function heapProblemFor(
  spec: { type: string; env: Record<string, string> },
  limits: ResourceLimits | undefined,
  node: NodeRecord
): string | null {
  const egg = getEgg(spec.type);
  if (!egg?.memoryVariable) return null;

  const heapMb = parseMemoryMb(spec.env[egg.memoryVariable] ?? '');
  if (heapMb == null) return null;

  const capMb = containerMemoryMb(limits?.ramPercent, node.ramTotalMb);
  if (capMb == null) return null;

  return heapBudgetProblem({ heapMb, capMb });
}

function dataMountFor(config: ServerConfigRecord): { dataMount?: { hostPath: string; containerPath: string } } {
  if (!config.dataPath) return {};
  const containerPath = getEgg(config.type)?.dataPath;
  if (!containerPath) return {};
  return { dataMount: { hostPath: config.dataPath, containerPath } };
}

function userIdOf(req: Request): string {
  return principalOf(req).id;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { repo } = deps;
  const publish = deps.publish ?? publishRabbitEvent;
  const selectNode = deps.selectNode ?? defaultSelectNode;
  const provisionDatabase = deps.provisionDatabase ?? defaultProvisionDatabase;
  const deprovisionDatabase = deps.deprovisionDatabase ?? defaultDeprovisionDatabase;
  const snapshotBackup = deps.snapshotBackup ?? defaultSnapshotBackup;
  const restoreBackup = deps.restoreBackup ?? defaultRestoreBackup;
  const removeBackup = deps.removeBackup ?? defaultRemoveBackup;
  const scheduleActions = deps.scheduleActions ?? noopScheduleActions;
  const checkQuota = deps.checkQuota ?? defaultCheckQuota;
  const router = Router();

  const emit = (routingKey: string, event: NexusInfraEvent) =>
    publish(routingKey, buildEnvelope('orchestrator', event));

  // Which agent owns this deployment (#171). Falls back to NODE_AGENT_URL when the
  // node advertises no URL, so single-node setups are unaffected.
  const agentUrlFor = async (nodeId: string | null): Promise<string> => {
    if (!nodeId) return resolveAgentUrl(null, NODE_AGENT_URL);
    const node = (await repo.listNodes()).find((n) => n.id === nodeId);
    return resolveAgentUrl(node, NODE_AGENT_URL);
  };

  // Create a deployment: persist config, place it on the least-loaded node, and
  // command the agent to start it.
  router.post('/deployments', async (req: Request, res: Response) => {
    const { name, dockerImage, ports, env, resourceLimits, autoRestart, type, nodeId, eggId, eggValues, dataPath } = req.body ?? {};
    if (typeof name !== 'string' || !name) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Deploying from an egg (#231): the recipe decides the image, ports and
    // environment, so anything the caller sent for those is ignored rather than
    // merged. An egg that could be overridden would be a suggestion, not a recipe
    // — you could run any image at all and still be labelled a Minecraft server.
    let spec: { dockerImage: string; ports: Record<string, string>; env: Record<string, string>; type: string; dataPath?: string };
    if (eggId !== undefined) {
      if (typeof eggId !== 'string') return res.status(400).json({ error: 'eggId must be a string' });
      const egg = getEgg(eggId);
      if (!egg) return res.status(400).json({ error: `unknown egg ${eggId}` });
      try {
        const built = buildEggDeployment(egg, (eggValues ?? {}) as Record<string, string>, ports as Record<string, string> | undefined);
        spec = { dockerImage: built.dockerImage, ports: built.ports, env: built.env, type: egg.id, dataPath: built.dataPath };
      } catch (err) {
        // The egg names the field as the person saw it, so pass the message through.
        if (err instanceof EggValidationError) return res.status(400).json({ error: err.message });
        throw err;
      }
    } else {
      if (typeof dockerImage !== 'string' || !dockerImage) {
        return res.status(400).json({ error: 'dockerImage is required when no egg is given' });
      }
      spec = {
        dockerImage,
        ports: ports ?? {},
        env: env ?? {},
        type: typeof type === 'string' ? type : 'generic',
      };
    }

    // Enforce the plan's server quota (hosted edition; no-op in community).
    const userId = userIdOf(req);
    const currentServers = (await repo.listDeployments()).filter((d) => d.userId === userId).length;
    const serverQuota = await checkQuota(userId, 'servers', currentServers);
    if (!serverQuota.allowed) {
      return res.status(409).json({ error: `server quota reached for your plan (max ${serverQuota.limit})` });
    }

    // Placement: a pinned node is honoured, anything else is least-loaded (#254).
    // Pinning is a deliberate choice — an unknown or unhealthy target is refused
    // rather than quietly reassigned, which is what made the picker a no-op.
    const nodes = await repo.listNodes();
    let node: NodeRecord | null;
    if (typeof nodeId === 'string' && nodeId) {
      const pinned = nodes.find((n) => n.id === nodeId);
      if (!pinned) return res.status(400).json({ error: `unknown node ${nodeId}` });
      if (nodeHealth(pinned, Date.now()) !== 'healthy') {
        return res.status(409).json({ error: `node ${nodeId} is not healthy` });
      }
      if (pinned.maintenance) {
        return res.status(409).json({ error: `node ${nodeId} is in maintenance` });
      }
      node = pinned;
    } else {
      node = selectNode(nodes, Date.now());
    }
    if (!node) {
      return res.status(503).json({ error: 'No healthy node available to place the deployment' });
    }

    // Importing an existing directory (#268). Platform-admin only: a bind mount is
    // a host-escape primitive, and a per-server role must never be able to point
    // one anywhere. The *node* decides whether the path is allowed — it is the only
    // process that can see its own filesystem — and it checks again at start.
    let importedPath: string | null = null;
    if (dataPath !== undefined && dataPath !== null && dataPath !== '') {
      const principal = principalOf(req);
      if (principal.platformRole !== 'admin' && principal.platformRole !== 'owner') {
        return res.status(403).json({ error: 'only a platform administrator may import a directory' });
      }
      if (!spec.dataPath) {
        return res.status(400).json({ error: 'importing a directory needs an egg, which decides where it is mounted' });
      }
      try {
        const agentUrl = await agentUrlFor(node.id);
        const r = await agentFetch(`${agentUrl}/imports/resolve`, asJson('POST', { path: dataPath }));
        const body = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!r.ok) return res.status(400).json({ error: body.error ?? 'the node refused that directory' });
        importedPath = body.path ?? String(dataPath);
      } catch {
        return res.status(502).json({ error: 'node agent unreachable' });
      }
    }

    // The container cap and the JVM heap are two settings for the same physical
    // RAM (#271). The kernel enforces the cap absolutely and the JVM commits its
    // heap, so a heap that does not fit is not a slow server — it is a container
    // killed mid-save, reported only as "crashed". Checked here because the cap is
    // a percentage of *this* node, so the answer needs the node.
    const limits: ResourceLimits = resourceLimits && typeof resourceLimits === 'object' ? resourceLimits : {};
    const heapProblem = heapProblemFor(spec, limits, node);
    if (heapProblem) return res.status(400).json({ error: heapProblem });

    const config = await repo.createServerConfig({
      userId,
      name,
      dataPath: importedPath,
      dockerImage: spec.dockerImage,
      ports: spec.ports,
      env: spec.env,
      resourceLimits: limits,
      autoRestart: Boolean(autoRestart),
      type: spec.type,
    });
    const deployment = await repo.createDeployment(config.id, node.id);
    await repo.appendDeploymentEvent(deployment.id, 'created', `placed on node ${node.id}`);

    await emit('infra.deployment.created', { type: 'deployment.created', payload: { deploymentId: deployment.id, userId: config.userId, resourceLimits: config.resourceLimits } });
    await emit(KEY_START, {
      type: 'server.start',
      payload: {
        deploymentId: deployment.id,
        nodeId: node.id,
        dockerImage: config.dockerImage,
        containerName: config.name,
        env: config.env,
        ports: config.ports,
        resourceLimits: config.resourceLimits,
        ...dataMountFor(config),
      },
    });

    const detail = await repo.getDeployment(deployment.id);
    return res.status(201).json(detail);
  });

  // Scoped to what the caller may see: their own servers plus the ones shared
  // with them. A platform administrator sees the whole installation.
  router.get('/deployments', async (req: Request, res: Response) => {
    const principal = principalOf(req);
    if (principal.platformRole === 'owner' || principal.platformRole === 'admin') {
      return res.json((await repo.listDeployments()).map((d) => ({ ...d, role: 'owner' })));
    }
    const caller = await repo.getUser(principal.id);
    if (!caller) return res.json([]);
    const visible = await repo.listDeploymentsForUser(caller);
    // Each row carries the caller's role so the panel can offer only the actions
    // that will actually succeed (#178).
    return res.json(
      await Promise.all(
        visible.map(async (d) => {
          const share = await repo.getSubuserFor(d.id, caller.email);
          return {
            ...d,
            role: resolveRole({
              principal,
              ownerId: d.userId,
              teamId: d.teamId,
              grant: share?.status === 'active' && share.userId === principal.id ? share : null,
              membership: d.teamId ? await repo.getTeamMember(d.teamId, principal.id) : null,
            }),
          };
        })
      )
    );
  });

  // Everything addressing one server passes through the guard, so a route added
  // below is protected by default; it only has to declare what it needs.
  router.use('/deployments/:id', accessGuard(repo));
  // Attaching a server to a team sits behind the same guard (#177).
  router.use(createServerTeamRouter({ repo }));

  router.get('/deployments/:id', requirePermission('server.view'), (req: Request, res: Response) => {
    res.json({ ...accessOf(req).deployment, role: accessOf(req).role });
  });

  // Change an existing server's configuration (#220). Before this a server was
  // frozen at creation: correcting a typo in a name meant deleting it, and its
  // databases, backups, schedules and subusers went with it.
  //
  // Deliberately does not touch the running container. A config change that
  // silently restarted someone's server would be a worse surprise than one that
  // waits; the panel says the change lands on the next start.
  router.patch('/deployments/:id', requirePermission('server.edit'), async (req: Request, res: Response) => {
    const { name, dockerImage, ports, env, resourceLimits, autoRestart } = req.body ?? {};
    const patch: UpdateServerConfigInput = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
      patch.name = name.trim();
    }
    if (dockerImage !== undefined) {
      if (typeof dockerImage !== 'string' || !dockerImage.trim()) return res.status(400).json({ error: 'dockerImage cannot be empty' });
      patch.dockerImage = dockerImage.trim();
    }
    const isRecord = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (ports !== undefined) {
      if (!isRecord(ports)) return res.status(400).json({ error: 'ports must be an object' });
      patch.ports = ports as Record<string, string>;
    }
    if (env !== undefined) {
      if (!isRecord(env)) return res.status(400).json({ error: 'env must be an object' });
      patch.env = env as Record<string, string>;
    }
    if (resourceLimits !== undefined) {
      if (!isRecord(resourceLimits)) return res.status(400).json({ error: 'resourceLimits must be an object' });
      patch.resourceLimits = resourceLimits as ServerConfigRecord['resourceLimits'];
    }
    if (autoRestart !== undefined) patch.autoRestart = Boolean(autoRestart);

    const updated = await repo.updateDeploymentConfig(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'deployment not found' });

    await repo.appendDeploymentEvent(
      req.params.id,
      'config-updated',
      `configuration changed (${Object.keys(patch).join(', ') || 'no fields'})`
    );
    const detail = await repo.getDeployment(req.params.id);
    return res.json({ ...detail, role: accessOf(req).role });
  });

  // The audit trail, newest first (#223). Every lifecycle change has written a
  // DeploymentEvent since the beginning and nothing ever read them back, so the
  // trail was write-only — useless at the moment you actually need it ("who
  // stopped my server, and when did it crash"). Paginated because a long-lived
  // server accumulates these indefinitely.
  router.get('/deployments/:id/events', requirePermission('server.view'), (req: Request, res: Response) => {
    const clamp = (v: unknown, fallback: number, max: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
    };
    const limit = clamp(req.query.limit, 50, 200);
    const offset = clamp(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

    // The repository stores them oldest-first; reading a trail starts at the end.
    const events = [...accessOf(req).deployment.events].reverse();
    return res.json(events.slice(offset, offset + limit));
  });

  // Request a running deployment be stopped: command the agent, which reports
  // server.stopped back (lifecycle.ts flips the status).
  router.post('/deployments/:id/stop', requirePermission('control.stop'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId || !detail.nodeId) {
      return res.status(409).json({ error: 'deployment is not running' });
    }

    await repo.appendDeploymentEvent(detail.id, 'stop-requested', 'stop requested by user');
    await emit(KEY_STOP, {
      type: 'server.stop',
      payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
    });
    return res.status(202).json({ status: 'stopping', deploymentId: detail.id });
  });

  // Force-terminate a container that ignores a graceful stop (#253). Same
  // permission as stop — it is the same intent, applied harder — but its own
  // command and its own audit entry, so the trail can say which one happened.
  router.post('/deployments/:id/kill', requirePermission('control.stop'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId || !detail.nodeId) {
      return res.status(409).json({ error: 'deployment is not running' });
    }

    await repo.appendDeploymentEvent(detail.id, 'kill-requested', 'force kill requested by user');
    await emit(KEY_KILL, {
      type: 'server.kill',
      payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
    });
    return res.status(202).json({ status: 'killing', deploymentId: detail.id });
  });

  // Start (or re-run) a deployment that isn't currently running: re-place it on a
  // healthy node and command a fresh container from its saved config.
  router.post('/deployments/:id/start', requirePermission('control.start'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (detail.status === 'running' || detail.status === 'pending') {
      return res.status(409).json({ error: 'deployment is already running' });
    }
    const config = await repo.getDeploymentConfig(detail.id);
    if (!config) return res.status(404).json({ error: 'server config not found' });

    const node = selectNode(await repo.listNodes(), Date.now());
    if (!node) return res.status(503).json({ error: 'No healthy node available to place the deployment' });

    await repo.updateDeploymentStatus(detail.id, {
      status: 'pending',
      nodeId: node.id,
      containerId: null,
      startedAt: null,
      stoppedAt: null,
    });
    await repo.appendDeploymentEvent(detail.id, 'start-requested', `re-placed on node ${node.id}`);
    await emit(KEY_START, {
      type: 'server.start',
      payload: {
        deploymentId: detail.id,
        nodeId: node.id,
        dockerImage: config.dockerImage,
        containerName: config.name,
        env: config.env,
        ports: config.ports,
        resourceLimits: config.resourceLimits,
        ...dataMountFor(config),
      },
    });
    return res.status(202).json({ status: 'starting', deploymentId: detail.id });
  });

  // Request a running deployment be restarted — the agent restarts the container
  // and reports server.started back.
  router.post('/deployments/:id/restart', requirePermission('control.restart'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId || !detail.nodeId) {
      return res.status(409).json({ error: 'deployment is not running' });
    }

    await repo.appendDeploymentEvent(detail.id, 'restart-requested', 'restart requested by user');
    await emit(KEY_RESTART, {
      type: 'server.restart',
      payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
    });
    return res.status(202).json({ status: 'restarting', deploymentId: detail.id });
  });

  // Permanently delete a deployment: stop its container if running, deprovision
  // any managed database containers, then drop the deployment and its records.
  router.delete('/deployments/:id', requirePermission('server.delete'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });

    if (detail.containerId && detail.nodeId) {
      await emit(KEY_STOP, {
        type: 'server.stop',
        payload: { deploymentId: detail.id, nodeId: detail.nodeId, containerId: detail.containerId },
      });
    }
    const ownerAgentUrl = await agentUrlFor(detail.nodeId);
    for (const db of await repo.listDatabases(detail.id)) {
      if (db.containerId) {
        try {
          await deprovisionDatabase(ownerAgentUrl, db.containerId);
        } catch {
          // Best-effort: still remove the record so nothing is orphaned in the UI.
        }
      }
    }
    await repo.deleteDeployment(detail.id);
    return res.status(204).end();
  });

  // The egg catalogue (#231) — what a server can be created from. Readable to any
  // signed-in user: it is a menu, and the panel builds its form from it rather
  // than carrying a second copy that could drift.
  router.get('/eggs', (_req: Request, res: Response) => {
    res.json(EGGS);
  });

  // Node health is what the Overview renders, so it stays readable to any
  // signed-in user; changing the fleet does not.
  router.get('/nodes', async (_req: Request, res: Response) => {
    const now = Date.now();
    const nodes = await repo.listNodes();
    res.json(nodes.map((n) => ({ ...n, health: nodeHealth(n, now) })));
  });

  // Register (or relabel) a node's metadata (#113). It reads offline until an agent
  // started with NODE_ID=<id> heartbeats in. Body: { id?, name?, location? }.
  router.post('/nodes', requirePlatformAdmin, async (req: Request, res: Response) => {
    const { id, name, location, agentUrl } = req.body ?? {};
    const nodeId = typeof id === 'string' && id.trim() ? id.trim() : `node-${randomToken()}`;
    const node = await repo.registerNode({
      id: nodeId,
      name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      location: typeof location === 'string' ? location.trim() || null : undefined,
      agentUrl: typeof agentUrl === 'string' ? agentUrl.trim() || null : undefined,
    });
    return res.status(201).json({ ...node, health: nodeHealth(node, Date.now()) });
  });

  // Drain a node, or put it back in the pool (#258). Maintenance means "keep
  // running what you have, take nothing new"; it deliberately does not stop the
  // deployments already there, which is the operator's separate decision.
  router.patch('/nodes/:id/maintenance', requirePlatformAdmin, async (req: Request, res: Response) => {
    const { maintenance } = req.body ?? {};
    if (typeof maintenance !== 'boolean') {
      return res.status(400).json({ error: 'maintenance must be a boolean' });
    }
    const existing = (await repo.listNodes()).find((n) => n.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'node not found' });

    const node = await repo.registerNode({ id: req.params.id, maintenance });
    return res.json({ ...node, health: nodeHealth(node, Date.now()) });
  });

  // Deregister a node — refused while it still hosts a running deployment.
  router.delete('/nodes/:id', requirePlatformAdmin, async (req: Request, res: Response) => {
    const running = (await repo.listDeployments()).some((d) => d.nodeId === req.params.id && (d.status === 'running' || d.status === 'pending'));
    if (running) return res.status(409).json({ error: 'node still hosts a running deployment' });
    await repo.deleteNode(req.params.id);
    return res.status(204).end();
  });

  // Pipe an SSE stream from the owning Node Agent's internal `/{kind}/:containerId`
  // endpoint straight to the client, resolving the running container first.
  const proxyContainerStream = (kind: 'logs' | 'stats') => async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    const target = resolveContainerTarget(detail);
    if (target.status !== 200) return res.status(target.status).json({ error: target.error });
    const agentUrl = await agentUrlFor(detail!.nodeId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const upstream = await agentFetch(`${agentUrl}/${kind}/${target.containerId}`, { signal: controller.signal });
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // client disconnected or upstream closed
    }
    res.end();
  };

  // Stream a running deployment's logs / resource stats (SSE), proxied from the
  // owning Node Agent.
  router.get('/deployments/:id/logs', requirePermission('server.logs'), proxyContainerStream('logs'));
  router.get('/deployments/:id/stats', requirePermission('server.stats'), proxyContainerStream('stats'));

  // ── File management (#108) — proxy CRUD to the owning Node Agent ─────────────
  // Resolve the running container, forward the file op, and mirror the agent's
  // status + JSON body back to the caller.
  const fileBase = (agentUrl: string, containerId: string) => `${agentUrl}/files/${containerId}`;
  const withContainer = async (req: Request, res: Response, upstream: (containerId: string, agentUrl: string) => Promise<globalThis.Response>) => {
    const detail = await repo.getDeployment(req.params.id);
    const target = resolveContainerTarget(detail);
    if (target.status !== 200) return res.status(target.status).json({ error: target.error });
    try {
      const r = await upstream(target.containerId!, await agentUrlFor(detail!.nodeId));
      const body = await r.text();
      res.status(r.status);
      return body ? res.type('application/json').send(body) : res.end();
    } catch {
      return res.status(502).json({ error: 'node agent unreachable' });
    }
  };
  const q = (v: unknown) => encodeURIComponent(String(v ?? ''));
  const asJson = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  router.get('/deployments/:id/files', requirePermission('file.read'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${fileBase(a, c)}?path=${q(req.query.path ?? '/')}`)));
  router.get('/deployments/:id/files/content', requirePermission('file.read'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${fileBase(a, c)}/content?path=${q(req.query.path)}`)));
  router.put('/deployments/:id/files/content', requirePermission('file.write'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${fileBase(a, c)}/content`, asJson('PUT', req.body))));
  router.post('/deployments/:id/files/dir', requirePermission('file.write'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${fileBase(a, c)}/dir`, asJson('POST', req.body))));
  router.post('/deployments/:id/files/rename', requirePermission('file.write'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${fileBase(a, c)}/rename`, asJson('POST', req.body))));
  router.delete('/deployments/:id/files', requirePermission('file.write'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${fileBase(a, c)}?path=${q(req.query.path)}`, { method: 'DELETE' })));

  // Binary-safe upload (#263). The body stays raw bytes the whole way: reading an
  // upload as text and re-encoding it destroys every byte that is not valid UTF-8,
  // which silently corrupted every JAR, zip and image the panel uploaded.
  router.put(
    '/deployments/:id/files/binary',
    requirePermission('file.write'),
    raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES }),
    (req, res) =>
      withContainer(req, res, (c, a) =>
        agentFetch(`${fileBase(a, c)}/binary?path=${q(req.query.path)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(),
        })
      )
  );

  // ── Console (#68) — run a one-shot command in the running container ─────────
  router.post('/deployments/:id/exec', requirePermission('console.exec'), (req, res) => withContainer(req, res, (c, a) => agentFetch(`${a}/exec/${c}`, asJson('POST', req.body))));

  // ── Managed databases (#109) ────────────────────────────────────────────────
  // A database is its own engine container the owning node starts, with generated
  // credentials the Orchestrator records and hands back to the user.
  router.get('/deployments/:id/databases', requirePermission('database.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listDatabases(detail.id));
  });

  router.post('/deployments/:id/databases', requirePermission('database.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.nodeId || !detail.containerId) return res.status(409).json({ error: 'deployment is not running' });

    const engine = (req.body ?? {}).engine;
    if (!isDatabaseEngine(engine)) return res.status(400).json({ error: 'engine must be mysql, mariadb or postgres' });

    // Enforce the plan's database quota across all of the user's servers (hosted).
    const userDeployments = (await repo.listDeployments()).filter((d) => d.userId === detail.userId);
    let currentDatabases = 0;
    for (const dep of userDeployments) currentDatabases += (await repo.listDatabases(dep.id)).length;
    const dbQuota = await checkQuota(detail.userId, 'databases', currentDatabases);
    if (!dbQuota.allowed) {
      return res.status(409).json({ error: `database quota reached for your plan (max ${dbQuota.limit})` });
    }

    const existing = await repo.listDatabases(detail.id);
    const creds = generateDatabaseCredentials(detail.name, existing.length + 1);
    try {
      const { containerId, port } = await provisionDatabase({ agentUrl: await agentUrlFor(detail.nodeId), engine, ...creds });
      const db = await repo.createDatabase({
        deploymentId: detail.id,
        engine,
        ...creds,
        host: DB_PUBLIC_HOST,
        port,
        containerId,
      });
      return res.status(201).json(db);
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'database provisioning failed' });
    }
  });

  router.delete('/deployments/:id/databases/:dbId', requirePermission('database.manage'), async (req: Request, res: Response) => {
    const db = await repo.getDatabase(req.params.dbId);
    if (!db || db.deploymentId !== req.params.id) return res.status(404).json({ error: 'database not found' });
    if (db.containerId) {
      try {
        const owner = await repo.getDeployment(db.deploymentId);
        await deprovisionDatabase(await agentUrlFor(owner?.nodeId ?? null), db.containerId);
      } catch {
        // Best-effort: still drop the record so the UI isn't stuck on a ghost.
      }
    }
    await repo.deleteDatabase(db.id);
    return res.status(204).end();
  });

  // ── Backups (#110) — snapshot / restore a server's data volume ──────────────
  router.get('/deployments/:id/backups', requirePermission('backup.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listBackups(detail.id));
  });

  router.post('/deployments/:id/backups', requirePermission('backup.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId) return res.status(409).json({ error: 'deployment is not running' });

    const path = typeof (req.body ?? {}).path === 'string' ? req.body.path : undefined;
    try {
      const snap = await snapshotBackup({ agentUrl: await agentUrlFor(detail.nodeId), containerId: detail.containerId, path });
      const backup = await repo.createBackup({
        deploymentId: detail.id,
        name: `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        path: snap.path,
        ref: snap.ref,
        sizeBytes: snap.sizeBytes,
      });
      return res.status(201).json(backup);
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'backup failed' });
    }
  });

  router.post('/deployments/:id/backups/:backupId/restore', requirePermission('backup.manage'), async (req: Request, res: Response) => {
    const backup = await repo.getBackup(req.params.backupId);
    if (!backup || backup.deploymentId !== req.params.id) return res.status(404).json({ error: 'backup not found' });
    const detail = await repo.getDeployment(req.params.id);
    if (!detail?.containerId) return res.status(409).json({ error: 'deployment is not running' });
    try {
      await restoreBackup({ agentUrl: await agentUrlFor(detail.nodeId), containerId: detail.containerId, ref: backup.ref, path: backup.path });
      return res.status(200).json({ status: 'restored', backupId: backup.id });
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'restore failed' });
    }
  });

  router.delete('/deployments/:id/backups/:backupId', requirePermission('backup.manage'), async (req: Request, res: Response) => {
    const backup = await repo.getBackup(req.params.backupId);
    if (!backup || backup.deploymentId !== req.params.id) return res.status(404).json({ error: 'backup not found' });
    try {
      const owner = await repo.getDeployment(backup.deploymentId);
      await removeBackup(await agentUrlFor(owner?.nodeId ?? null), backup.ref);
    } catch {
      // Best-effort: drop the record even if the node file is already gone.
    }
    await repo.deleteBackup(backup.id);
    return res.status(204).end();
  });

  // ── Schedules (#111) — recurring restart/backup on a cron ───────────────────
  router.get('/deployments/:id/schedules', requirePermission('server.view'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listSchedules(detail.id));
  });

  router.post('/deployments/:id/schedules', requirePermission('schedule.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    const { name, cron, action, enabled } = req.body ?? {};
    if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name is required' });
    if (typeof cron !== 'string' || !isValidCron(cron)) return res.status(400).json({ error: 'a valid 5-field cron expression is required' });
    if (!SCHEDULE_ACTIONS.includes(action)) return res.status(400).json({ error: 'action must be restart or backup' });
    const schedule = await repo.createSchedule({ deploymentId: detail.id, name, cron, action, enabled: enabled !== false });
    return res.status(201).json(schedule);
  });

  router.patch('/deployments/:id/schedules/:sid', requirePermission('schedule.manage'), async (req: Request, res: Response) => {
    const s = await repo.getSchedule(req.params.sid);
    if (!s || s.deploymentId !== req.params.id) return res.status(404).json({ error: 'schedule not found' });
    const { name, cron, action, enabled } = req.body ?? {};
    if (cron !== undefined && (typeof cron !== 'string' || !isValidCron(cron))) return res.status(400).json({ error: 'invalid cron expression' });
    if (action !== undefined && !SCHEDULE_ACTIONS.includes(action)) return res.status(400).json({ error: 'action must be restart or backup' });
    const updated = await repo.updateSchedule(s.id, { name, cron, action, enabled });
    return res.json(updated);
  });

  router.delete('/deployments/:id/schedules/:sid', requirePermission('schedule.manage'), async (req: Request, res: Response) => {
    const s = await repo.getSchedule(req.params.sid);
    if (!s || s.deploymentId !== req.params.id) return res.status(404).json({ error: 'schedule not found' });
    await repo.deleteSchedule(s.id);
    return res.status(204).end();
  });

  // Run a schedule immediately ("Run now").
  router.post('/deployments/:id/schedules/:sid/run', requirePermission('schedule.manage'), async (req: Request, res: Response) => {
    const s = await repo.getSchedule(req.params.sid);
    if (!s || s.deploymentId !== req.params.id) return res.status(404).json({ error: 'schedule not found' });
    try {
      await runScheduleAction(scheduleActions, s);
      await repo.updateSchedule(s.id, { lastRunAt: new Date().toISOString() });
      return res.status(200).json({ status: 'ran', scheduleId: s.id });
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'schedule run failed' });
    }
  });

  // ── Subusers (#112) — per-server access control ─────────────────────────────
  // Who may access this server, and as what. These grants are what accessGuard
  // resolves on every request, so a change here takes effect immediately (#175).
  // Managing them is itself a permission, so an operator cannot widen their own
  // access or see who else has any.
  router.get('/deployments/:id/subusers', requirePermission('subuser.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listSubusers(detail.id));
  });

  router.post('/deployments/:id/subusers', requirePermission('subuser.manage'), async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    const { email, role } = req.body ?? {};
    if (typeof email !== 'string' || !isEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
    if (!isGrantableRole(role)) return res.status(400).json({ error: 'role must be admin, operator or viewer' });

    const address = email.trim().toLowerCase();
    if (address === (await repo.getUser(userIdOf(req)))?.email) {
      return res.status(400).json({ error: 'you already have access to this server' });
    }

    // Bind straight away when that person already has an account; otherwise the
    // invitation waits for them, granting nothing until then (#176).
    const invitee = await repo.getUserByEmail(address);
    const su = await repo.createSubuser({
      deploymentId: detail.id,
      email: address,
      role,
      userId: invitee?.id ?? null,
      status: invitee ? 'active' : 'pending',
    });
    return res.status(201).json(su);
  });

  router.patch('/deployments/:id/subusers/:sid', requirePermission('subuser.manage'), async (req: Request, res: Response) => {
    const su = await repo.getSubuser(req.params.sid);
    if (!su || su.deploymentId !== req.params.id) return res.status(404).json({ error: 'subuser not found' });
    const { role } = req.body ?? {};
    if (!isGrantableRole(role)) return res.status(400).json({ error: 'role must be admin, operator or viewer' });
    return res.json(await repo.updateSubuserRole(su.id, role));
  });

  router.delete('/deployments/:id/subusers/:sid', requirePermission('subuser.manage'), async (req: Request, res: Response) => {
    const su = await repo.getSubuser(req.params.sid);
    if (!su || su.deploymentId !== req.params.id) return res.status(404).json({ error: 'subuser not found' });
    await repo.deleteSubuser(su.id);
    return res.status(204).end();
  });

  return router;
}
