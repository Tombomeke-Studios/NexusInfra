import { Router, type Request, type Response } from 'express';
import { DEPLOYMENT_LABEL } from './volumes.js';

// How much disk each server on this node uses (#347). Node totals have been real
// since #276; this says *which* server is filling the disk.
//
// A server's disk is two things:
// - its data volumes (#324) — where nearly all of it lives;
// - its container's writable layer — anything written outside those volumes,
//   which a recreate throws away.
//
// Measured, never enforced: a cap on the volumes needs XFS project quotas
// (#278). And never invented: Docker reports -1 for a size it could not
// measure, and that stays unknown here rather than becoming a comforting 0.

/** The part of Docker's `GET /system/df` this reads. */
export interface DockerDf {
  Volumes?: Array<{ Name: string; Labels?: Record<string, string> | null; UsageData?: { Size?: number } | null }> | null;
  Containers?: Array<{ Labels?: Record<string, string> | null; SizeRw?: number }> | null;
}

export interface DeploymentDisk {
  deploymentId: string;
  /** All its volumes together; null when any of them could not be measured. */
  volumesBytes: number | null;
  /** Its container's writable layer; null when it has no container or Docker did not measure it. */
  writableBytes: number | null;
  volumes: Array<{ name: string; path: string | null; bytes: number | null }>;
}

const measured = (n: number | undefined): number | null => (typeof n === 'number' && n >= 0 ? n : null);

/** Every deployment's disk, from one `system df`. Pure. */
export function diskByDeployment(df: DockerDf): Map<string, DeploymentDisk> {
  const out = new Map<string, DeploymentDisk>();
  const entry = (id: string) => {
    let d = out.get(id);
    if (!d) {
      d = { deploymentId: id, volumesBytes: 0, writableBytes: null, volumes: [] };
      out.set(id, d);
    }
    return d;
  };

  for (const v of df.Volumes ?? []) {
    const id = v.Labels?.[DEPLOYMENT_LABEL];
    if (!id) continue;
    const d = entry(id);
    const bytes = measured(v.UsageData?.Size);
    d.volumes.push({ name: v.Name, path: v.Labels?.['nexusinfra.path'] ?? null, bytes });
    // One unmeasured volume makes the total unknown: a partial sum would
    // understate exactly the server someone is trying to find.
    d.volumesBytes = bytes === null || d.volumesBytes === null ? null : d.volumesBytes + bytes;
  }

  for (const c of df.Containers ?? []) {
    const id = c.Labels?.[DEPLOYMENT_LABEL];
    if (!id) continue;
    const d = entry(id);
    const bytes = measured(c.SizeRw);
    if (bytes !== null) d.writableBytes = (d.writableBytes ?? 0) + bytes;
  }

  return out;
}

/** The total for one deployment, or null when nothing of it could be measured. */
export function totalBytes(d: Pick<DeploymentDisk, 'volumesBytes' | 'writableBytes'>): number | null {
  if (d.volumesBytes === null) return null;
  return d.volumesBytes + (d.writableBytes ?? 0);
}

/**
 * `system df` walks every volume, so on a node with a large world it takes a
 * while. One measurement serves every caller for `ttlMs`, and concurrent callers
 * share the walk in flight rather than each starting one.
 */
export function createDiskUsageCache(fetchDf: () => Promise<DockerDf>, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; byDeployment: Map<string, DeploymentDisk> } | null = null;
  let inFlight: Promise<{ at: number; byDeployment: Map<string, DeploymentDisk> }> | null = null;

  return async function measure() {
    if (cached && now() - cached.at < ttlMs) return cached;
    if (!inFlight) {
      inFlight = fetchDf()
        .then((df) => (cached = { at: now(), byDeployment: diskByDeployment(df) }))
        .finally(() => (inFlight = null));
    }
    return inFlight;
  };
}

export function createDiskUsageRouter(measure: ReturnType<typeof createDiskUsageCache>): Router {
  const router = Router();

  // Every server on this node, largest first — what the node's view lists.
  router.get('/disk', async (_req: Request, res: Response) => {
    try {
      const { at, byDeployment } = await measure();
      const deployments = [...byDeployment.values()].sort((a, b) => (totalBytes(b) ?? -1) - (totalBytes(a) ?? -1));
      res.json({ measuredAt: new Date(at).toISOString(), deployments });
    } catch (err) {
      res.status(502).json({ error: `Docker could not measure disk use: ${err instanceof Error ? err.message : err}` });
    }
  });

  router.get('/deployments/:id/disk', async (req: Request, res: Response) => {
    try {
      const { at, byDeployment } = await measure();
      // No volumes and no container means nothing of it is on this node: zero
      // volumes measured, and no writable layer to speak of.
      const d = byDeployment.get(req.params.id) ?? { deploymentId: req.params.id, volumesBytes: 0, writableBytes: null, volumes: [] };
      res.json({ measuredAt: new Date(at).toISOString(), ...d });
    } catch (err) {
      res.status(502).json({ error: `Docker could not measure disk use: ${err instanceof Error ? err.message : err}` });
    }
  });

  return router;
}
