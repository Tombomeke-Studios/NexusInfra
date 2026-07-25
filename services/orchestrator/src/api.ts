import { Router, type Request, type Response } from 'express';
import { buildEnvelope, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent } from 'shared';
import { nodeHealth } from './nodeRegistry.js';
import { selectNode as defaultSelectNode } from './nodeSelection.js';
import { generateDatabaseCredentials, isDatabaseEngine } from './dbProvision.js';
import { isValidCron } from './cron.js';
import { runScheduleAction, type ScheduleActions } from './scheduler.js';
import type { DeploymentDetail, NodeRecord, Repository } from './types.js';

const SCHEDULE_ACTIONS = ['restart', 'backup'];
const SUBUSER_ROLES = ['admin', 'viewer'];
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// Short id suffix for an auto-generated node id (not security-sensitive).
const randomToken = () => Math.random().toString(36).slice(2, 8);

// Where the (single, local) Node Agent's internal HTTP lives. Multi-node will
// resolve this per node from the registry.
const NODE_AGENT_URL = process.env.NODE_AGENT_URL || 'http://node-agent:9100';

/** Decide whether a deployment's container can be streamed from, and which one. */
export function resolveContainerTarget(detail: DeploymentDetail | null): { status: number; error?: string; containerId?: string } {
  if (!detail) return { status: 404, error: 'deployment not found' };
  if (!detail.containerId) return { status: 409, error: 'deployment is not running' };
  return { status: 200, containerId: detail.containerId };
}

// Deployment REST API — the user-facing entry point that turns a server config
// into a running container. Creating a deployment picks a node and emits
// infra.server.start; the Node Agent runs the container and reports back (handled
// by lifecycle.ts). Auth is layered on separately (see auth.ts): handlers read the
// user id that middleware puts on the request, defaulting to a dev user locally.

const KEY_START = 'infra.server.start';
const KEY_STOP = 'infra.server.stop';
const KEY_RESTART = 'infra.server.restart';

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;
export type SelectNodeFn = (nodes: NodeRecord[], now: number) => NodeRecord | null;

/** Provisions a database container on the owning Node Agent; returns its id + host port. */
export type ProvisionDatabaseFn = (req: { engine: string; name: string; username: string; password: string }) => Promise<{ containerId: string; port: number }>;
export type DeprovisionDatabaseFn = (containerId: string) => Promise<void>;

/** Snapshot / restore / delete a container backup on the owning Node Agent. */
export type SnapshotBackupFn = (req: { containerId: string; path?: string }) => Promise<{ ref: string; sizeBytes: number; path: string }>;
export type RestoreBackupFn = (req: { containerId: string; ref: string; path: string }) => Promise<void>;
export type RemoveBackupFn = (ref: string) => Promise<void>;

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
}

const noopScheduleActions: ScheduleActions = { restart: async () => {}, backup: async () => {} };

// Default provisioning talks to the Node Agent's internal database HTTP.
const defaultProvisionDatabase: ProvisionDatabaseFn = async (req) => {
  const r = await fetch(`${NODE_AGENT_URL}/databases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'database provisioning failed');
  return (await r.json()) as { containerId: string; port: number };
};

const defaultDeprovisionDatabase: DeprovisionDatabaseFn = async (containerId) => {
  await fetch(`${NODE_AGENT_URL}/databases/${containerId}`, { method: 'DELETE' });
};

const DB_PUBLIC_HOST = process.env.DATABASE_PUBLIC_HOST || 'localhost';

const defaultSnapshotBackup: SnapshotBackupFn = async (req) => {
  const r = await fetch(`${NODE_AGENT_URL}/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'backup failed');
  return (await r.json()) as { ref: string; sizeBytes: number; path: string };
};

const defaultRestoreBackup: RestoreBackupFn = async (req) => {
  const r = await fetch(`${NODE_AGENT_URL}/backups/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'restore failed');
};

const defaultRemoveBackup: RemoveBackupFn = async (ref) => {
  await fetch(`${NODE_AGENT_URL}/backups/${ref}`, { method: 'DELETE' });
};

function userIdOf(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? 'dev-user';
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
  const router = Router();

  const emit = (routingKey: string, event: NexusInfraEvent) =>
    publish(routingKey, buildEnvelope('orchestrator', event));

  // Create a deployment: persist config, place it on the least-loaded node, and
  // command the agent to start it.
  router.post('/deployments', async (req: Request, res: Response) => {
    const { name, dockerImage, ports, env, resourceLimits, autoRestart, type } = req.body ?? {};
    if (typeof name !== 'string' || typeof dockerImage !== 'string' || !name || !dockerImage) {
      return res.status(400).json({ error: 'name and dockerImage are required' });
    }

    const node = selectNode(await repo.listNodes(), Date.now());
    if (!node) {
      return res.status(503).json({ error: 'No healthy node available to place the deployment' });
    }

    const config = await repo.createServerConfig({
      userId: userIdOf(req),
      name,
      dockerImage,
      ports: ports ?? {},
      env: env ?? {},
      resourceLimits: resourceLimits && typeof resourceLimits === 'object' ? resourceLimits : {},
      autoRestart: Boolean(autoRestart),
      type: typeof type === 'string' ? type : 'generic',
    });
    const deployment = await repo.createDeployment(config.id, node.id);
    await repo.appendDeploymentEvent(deployment.id, 'created', `placed on node ${node.id}`);

    await emit('infra.deployment.created', { type: 'deployment.created', payload: { deploymentId: deployment.id, userId: config.userId } });
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
      },
    });

    const detail = await repo.getDeployment(deployment.id);
    return res.status(201).json(detail);
  });

  router.get('/deployments', async (_req: Request, res: Response) => {
    res.json(await repo.listDeployments());
  });

  router.get('/deployments/:id', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(detail);
  });

  // Request a running deployment be stopped: command the agent, which reports
  // server.stopped back (lifecycle.ts flips the status).
  router.post('/deployments/:id/stop', async (req: Request, res: Response) => {
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

  // Start (or re-run) a deployment that isn't currently running: re-place it on a
  // healthy node and command a fresh container from its saved config.
  router.post('/deployments/:id/start', async (req: Request, res: Response) => {
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
      },
    });
    return res.status(202).json({ status: 'starting', deploymentId: detail.id });
  });

  // Request a running deployment be restarted — the agent restarts the container
  // and reports server.started back.
  router.post('/deployments/:id/restart', async (req: Request, res: Response) => {
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

  router.get('/nodes', async (_req: Request, res: Response) => {
    const now = Date.now();
    const nodes = await repo.listNodes();
    res.json(nodes.map((n) => ({ ...n, health: nodeHealth(n, now) })));
  });

  // Register (or relabel) a node's metadata (#113). It reads offline until an agent
  // started with NODE_ID=<id> heartbeats in. Body: { id?, name?, location? }.
  router.post('/nodes', async (req: Request, res: Response) => {
    const { id, name, location } = req.body ?? {};
    const nodeId = typeof id === 'string' && id.trim() ? id.trim() : `node-${randomToken()}`;
    const node = await repo.registerNode({
      id: nodeId,
      name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      location: typeof location === 'string' ? location.trim() || null : undefined,
    });
    return res.status(201).json({ ...node, health: nodeHealth(node, Date.now()) });
  });

  // Deregister a node — refused while it still hosts a running deployment.
  router.delete('/nodes/:id', async (req: Request, res: Response) => {
    const running = (await repo.listDeployments()).some((d) => d.nodeId === req.params.id && (d.status === 'running' || d.status === 'pending'));
    if (running) return res.status(409).json({ error: 'node still hosts a running deployment' });
    await repo.deleteNode(req.params.id);
    return res.status(204).end();
  });

  // Pipe an SSE stream from the owning Node Agent's internal `/{kind}/:containerId`
  // endpoint straight to the client, resolving the running container first.
  const proxyContainerStream = (kind: 'logs' | 'stats') => async (req: Request, res: Response) => {
    const target = resolveContainerTarget(await repo.getDeployment(req.params.id));
    if (target.status !== 200) return res.status(target.status).json({ error: target.error });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const upstream = await fetch(`${NODE_AGENT_URL}/${kind}/${target.containerId}`, { signal: controller.signal });
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
  router.get('/deployments/:id/logs', proxyContainerStream('logs'));
  router.get('/deployments/:id/stats', proxyContainerStream('stats'));

  // ── File management (#108) — proxy CRUD to the owning Node Agent ─────────────
  // Resolve the running container, forward the file op, and mirror the agent's
  // status + JSON body back to the caller.
  const fileBase = (containerId: string) => `${NODE_AGENT_URL}/files/${containerId}`;
  const withContainer = async (req: Request, res: Response, upstream: (containerId: string) => Promise<globalThis.Response>) => {
    const target = resolveContainerTarget(await repo.getDeployment(req.params.id));
    if (target.status !== 200) return res.status(target.status).json({ error: target.error });
    try {
      const r = await upstream(target.containerId!);
      const body = await r.text();
      res.status(r.status);
      return body ? res.type('application/json').send(body) : res.end();
    } catch {
      return res.status(502).json({ error: 'node agent unreachable' });
    }
  };
  const q = (v: unknown) => encodeURIComponent(String(v ?? ''));
  const asJson = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  router.get('/deployments/:id/files', (req, res) => withContainer(req, res, (c) => fetch(`${fileBase(c)}?path=${q(req.query.path ?? '/')}`)));
  router.get('/deployments/:id/files/content', (req, res) => withContainer(req, res, (c) => fetch(`${fileBase(c)}/content?path=${q(req.query.path)}`)));
  router.put('/deployments/:id/files/content', (req, res) => withContainer(req, res, (c) => fetch(`${fileBase(c)}/content`, asJson('PUT', req.body))));
  router.post('/deployments/:id/files/dir', (req, res) => withContainer(req, res, (c) => fetch(`${fileBase(c)}/dir`, asJson('POST', req.body))));
  router.post('/deployments/:id/files/rename', (req, res) => withContainer(req, res, (c) => fetch(`${fileBase(c)}/rename`, asJson('POST', req.body))));
  router.delete('/deployments/:id/files', (req, res) => withContainer(req, res, (c) => fetch(`${fileBase(c)}?path=${q(req.query.path)}`, { method: 'DELETE' })));

  // ── Console (#68) — run a one-shot command in the running container ─────────
  router.post('/deployments/:id/exec', (req, res) => withContainer(req, res, (c) => fetch(`${NODE_AGENT_URL}/exec/${c}`, asJson('POST', req.body))));

  // ── Managed databases (#109) ────────────────────────────────────────────────
  // A database is its own engine container the owning node starts, with generated
  // credentials the Orchestrator records and hands back to the user.
  router.get('/deployments/:id/databases', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listDatabases(detail.id));
  });

  router.post('/deployments/:id/databases', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.nodeId || !detail.containerId) return res.status(409).json({ error: 'deployment is not running' });

    const engine = (req.body ?? {}).engine;
    if (!isDatabaseEngine(engine)) return res.status(400).json({ error: 'engine must be mysql, mariadb or postgres' });

    const existing = await repo.listDatabases(detail.id);
    const creds = generateDatabaseCredentials(detail.name, existing.length + 1);
    try {
      const { containerId, port } = await provisionDatabase({ engine, ...creds });
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

  router.delete('/deployments/:id/databases/:dbId', async (req: Request, res: Response) => {
    const db = await repo.getDatabase(req.params.dbId);
    if (!db || db.deploymentId !== req.params.id) return res.status(404).json({ error: 'database not found' });
    if (db.containerId) {
      try {
        await deprovisionDatabase(db.containerId);
      } catch {
        // Best-effort: still drop the record so the UI isn't stuck on a ghost.
      }
    }
    await repo.deleteDatabase(db.id);
    return res.status(204).end();
  });

  // ── Backups (#110) — snapshot / restore a server's data volume ──────────────
  router.get('/deployments/:id/backups', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listBackups(detail.id));
  });

  router.post('/deployments/:id/backups', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    if (!detail.containerId) return res.status(409).json({ error: 'deployment is not running' });

    const path = typeof (req.body ?? {}).path === 'string' ? req.body.path : undefined;
    try {
      const snap = await snapshotBackup({ containerId: detail.containerId, path });
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

  router.post('/deployments/:id/backups/:backupId/restore', async (req: Request, res: Response) => {
    const backup = await repo.getBackup(req.params.backupId);
    if (!backup || backup.deploymentId !== req.params.id) return res.status(404).json({ error: 'backup not found' });
    const detail = await repo.getDeployment(req.params.id);
    if (!detail?.containerId) return res.status(409).json({ error: 'deployment is not running' });
    try {
      await restoreBackup({ containerId: detail.containerId, ref: backup.ref, path: backup.path });
      return res.status(200).json({ status: 'restored', backupId: backup.id });
    } catch (err) {
      return res.status(502).json({ error: err instanceof Error ? err.message : 'restore failed' });
    }
  });

  router.delete('/deployments/:id/backups/:backupId', async (req: Request, res: Response) => {
    const backup = await repo.getBackup(req.params.backupId);
    if (!backup || backup.deploymentId !== req.params.id) return res.status(404).json({ error: 'backup not found' });
    try {
      await removeBackup(backup.ref);
    } catch {
      // Best-effort: drop the record even if the node file is already gone.
    }
    await repo.deleteBackup(backup.id);
    return res.status(204).end();
  });

  // ── Schedules (#111) — recurring restart/backup on a cron ───────────────────
  router.get('/deployments/:id/schedules', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listSchedules(detail.id));
  });

  router.post('/deployments/:id/schedules', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    const { name, cron, action, enabled } = req.body ?? {};
    if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name is required' });
    if (typeof cron !== 'string' || !isValidCron(cron)) return res.status(400).json({ error: 'a valid 5-field cron expression is required' });
    if (!SCHEDULE_ACTIONS.includes(action)) return res.status(400).json({ error: 'action must be restart or backup' });
    const schedule = await repo.createSchedule({ deploymentId: detail.id, name, cron, action, enabled: enabled !== false });
    return res.status(201).json(schedule);
  });

  router.patch('/deployments/:id/schedules/:sid', async (req: Request, res: Response) => {
    const s = await repo.getSchedule(req.params.sid);
    if (!s || s.deploymentId !== req.params.id) return res.status(404).json({ error: 'schedule not found' });
    const { name, cron, action, enabled } = req.body ?? {};
    if (cron !== undefined && (typeof cron !== 'string' || !isValidCron(cron))) return res.status(400).json({ error: 'invalid cron expression' });
    if (action !== undefined && !SCHEDULE_ACTIONS.includes(action)) return res.status(400).json({ error: 'action must be restart or backup' });
    const updated = await repo.updateSchedule(s.id, { name, cron, action, enabled });
    return res.json(updated);
  });

  router.delete('/deployments/:id/schedules/:sid', async (req: Request, res: Response) => {
    const s = await repo.getSchedule(req.params.sid);
    if (!s || s.deploymentId !== req.params.id) return res.status(404).json({ error: 'schedule not found' });
    await repo.deleteSchedule(s.id);
    return res.status(204).end();
  });

  // Run a schedule immediately ("Run now").
  router.post('/deployments/:id/schedules/:sid/run', async (req: Request, res: Response) => {
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
  // Manages who may access a server and their role. Enforcement arrives with the
  // FinVault-JWT gateway (#20); this is the invite/role/revoke management layer.
  router.get('/deployments/:id/subusers', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    res.json(await repo.listSubusers(detail.id));
  });

  router.post('/deployments/:id/subusers', async (req: Request, res: Response) => {
    const detail = await repo.getDeployment(req.params.id);
    if (!detail) return res.status(404).json({ error: 'deployment not found' });
    const { email, role } = req.body ?? {};
    if (typeof email !== 'string' || !isEmail(email)) return res.status(400).json({ error: 'a valid email is required' });
    if (!SUBUSER_ROLES.includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
    const su = await repo.createSubuser({ deploymentId: detail.id, email: email.trim().toLowerCase(), role });
    return res.status(201).json(su);
  });

  router.patch('/deployments/:id/subusers/:sid', async (req: Request, res: Response) => {
    const su = await repo.getSubuser(req.params.sid);
    if (!su || su.deploymentId !== req.params.id) return res.status(404).json({ error: 'subuser not found' });
    const { role } = req.body ?? {};
    if (!SUBUSER_ROLES.includes(role)) return res.status(400).json({ error: 'role must be admin or viewer' });
    return res.json(await repo.updateSubuserRole(su.id, role));
  });

  router.delete('/deployments/:id/subusers/:sid', async (req: Request, res: Response) => {
    const su = await repo.getSubuser(req.params.sid);
    if (!su || su.deploymentId !== req.params.id) return res.status(404).json({ error: 'subuser not found' });
    await repo.deleteSubuser(su.id);
    return res.status(204).end();
  });

  return router;
}
