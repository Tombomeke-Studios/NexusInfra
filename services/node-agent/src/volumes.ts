import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';

// Where a server's data lives (#324).
//
// The agent removes a container on every stop (#52), so anything in its writable
// layer dies with it. A server's data directories are therefore named volumes,
// owned by the deployment and labelled with its id: created on first start,
// mounted again on every start after, and removed only when the server is
// deleted. Deterministic names are what make "again" work — the next container
// asks for the same name and Docker hands back the same volume.

/** Every container and volume belonging to one server carries this label. */
export const DEPLOYMENT_LABEL = 'nexusinfra.deployment';

/** What an orchestrator-issued id looks like; anything else is refused before it reaches a filter. */
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isDeploymentId(value: string): boolean {
  return DEPLOYMENT_ID.test(value);
}

function normalise(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.includes('..')) return null;
  return '/' + segments.join('/');
}

/**
 * The volume holding one directory of one server.
 *
 * Readable on `docker volume ls` (id prefix and a slug of the path) and exact via
 * a short hash, because `/a-b` and `/a/b` slug alike.
 */
export function volumeNameFor(deploymentId: string, path: string): string {
  const id = deploymentId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'server';
  const slug = path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'root';
  const hash = createHash('sha256').update(`${deploymentId}\0${path}`).digest('hex').slice(0, 8);
  return `nexus-${id}-${slug}-${hash}`;
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + '/');

/**
 * Which directories get a volume: what the orchestrator asked for (the egg's data
 * directory, an application's own list) plus every `VOLUME` the image declares —
 * an image author who declared one is saying "my data lives here", and ignoring
 * that is how a database loses its tables on restart.
 *
 * An imported directory (#268) is a host bind and wins over all of them: a volume
 * on the same path, or under it, would hide the operator's files.
 */
export function pathsToPersist(input: { requested: string[]; imageVolumes: string[]; dataMountPath?: string }): string[] {
  const out: string[] = [];
  for (const raw of [...input.requested, ...input.imageVolumes]) {
    const path = normalise(raw);
    if (!path || out.includes(path)) continue;
    if (input.dataMountPath && within(path, input.dataMountPath)) continue;
    out.push(path);
  }
  return out;
}

export interface VolumeMount {
  Type: 'volume';
  Source: string;
  Target: string;
}

export function volumeMounts(deploymentId: string, paths: string[]): VolumeMount[] {
  return paths.map((path) => ({ Type: 'volume', Source: volumeNameFor(deploymentId, path), Target: path }));
}

/**
 * Internal HTTP: remove everything a deleted server left on this node.
 *
 * Only what carries the server's label — never an imported host directory, which
 * belongs to the operator, and never anything the platform did not create.
 */
export function createDataRouter(runtime: ContainerRuntime): Router {
  const router = Router();
  router.delete('/deployments/:id/data', async (req: Request, res: Response) => {
    if (!isDeploymentId(req.params.id)) return res.status(400).json({ error: 'invalid deployment id' });
    try {
      return res.json(await runtime.purgeDeployment(req.params.id));
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'could not remove server data' });
    }
  });
  return router;
}
