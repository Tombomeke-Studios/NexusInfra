// What the agent is told when a server starts (#324).
//
// Built in one place because it was built in three — creation, start, and
// reconciliation's restart — and the third had already drifted: it left out an
// imported server's mount, so a server restarted by reconciliation came back
// without its data directory. Pure, so every caller gets the same answer.

import { getEgg } from './eggs.js';
import { containerNameFor } from './containerName.js';
import type { ResourceLimits, ServerConfigRecord } from './types.js';

/** At most this many extra directories per server — each one is a volume on the node. */
export const MAX_PERSIST_PATHS = 10;

export interface StartCommand {
  deploymentId: string;
  nodeId: string;
  dockerImage: string;
  containerName: string;
  env: Record<string, string>;
  ports: Record<string, string>;
  resourceLimits: ResourceLimits;
  dataMount?: { hostPath: string; containerPath: string };
  /** Container directories the agent keeps in named volumes owned by this deployment. */
  persistPaths: string[];
}

/**
 * The host directory an imported server mounts, if it imported one (#268).
 *
 * Where it mounts comes from the egg rather than a stored copy, so a server always
 * follows the catalogue rather than a value frozen when it was created.
 */
export function dataMountFor(config: ServerConfigRecord): { hostPath: string; containerPath: string } | undefined {
  if (!config.dataPath) return undefined;
  const containerPath = getEgg(config.type)?.dataPath;
  if (!containerPath) return undefined;
  return { hostPath: config.dataPath, containerPath };
}

/**
 * Which container directories must outlive the container.
 *
 * The agent removes a container on every stop (#52), so anything not listed here
 * — or declared as a `VOLUME` by the image, which the agent adds itself — is lost
 * on the next stop. An imported directory is already a host mount, and giving
 * the same path a volume as well would hide it.
 */
export function persistPathsFor(config: ServerConfigRecord): string[] {
  const mount = dataMountFor(config);
  const eggPath = getEgg(config.type)?.dataPath;
  const paths = [...(eggPath ? [eggPath] : []), ...(config.persistPaths ?? [])];
  return [...new Set(paths)].filter((p) => p !== mount?.containerPath);
}

export function startCommandFor(config: ServerConfigRecord, deploymentId: string, nodeId: string): StartCommand {
  const dataMount = dataMountFor(config);
  return {
    deploymentId,
    nodeId,
    dockerImage: config.dockerImage,
    containerName: containerNameFor(config.name, deploymentId),
    env: config.env,
    ports: config.ports,
    resourceLimits: config.resourceLimits,
    ...(dataMount ? { dataMount } : {}),
    persistPaths: persistPathsFor(config),
  };
}

/**
 * Validate the directories a caller asks to persist.
 *
 * Absolute, normalised, not the root (a volume over `/` hides the whole image),
 * no `..` (the agent would resolve it inside the container, but a path that
 * means something other than it says is not one to store), and no `:` (the
 * separator in Docker's own mount notation).
 */
export function parsePersistPaths(value: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'persistPaths must be a list of absolute directories' };
  if (value.length > MAX_PERSIST_PATHS) return { ok: false, error: `at most ${MAX_PERSIST_PATHS} persistent directories per server` };
  const paths: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.startsWith('/')) {
      return { ok: false, error: 'persistent directories must be absolute paths, like /data' };
    }
    const segments = raw.split('/').filter(Boolean);
    if (segments.length === 0) return { ok: false, error: 'the container root cannot be persisted' };
    if (segments.includes('..') || segments.includes('.')) return { ok: false, error: `${raw} is not a plain path` };
    if (raw.includes(':')) return { ok: false, error: `${raw} contains ':'` };
    const normalised = '/' + segments.join('/');
    if (normalised.length > 200) return { ok: false, error: `${raw} is too long` };
    if (!paths.includes(normalised)) paths.push(normalised);
  }
  return { ok: true, paths };
}
