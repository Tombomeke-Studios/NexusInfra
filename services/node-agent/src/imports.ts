import path from 'path';
import { Router, type Request, type Response } from 'express';

// Importing an existing server directory (#268) — bringing a folder that is
// already on the node under the panel, by bind-mounting it into the container.
//
// This is the most dangerous thing the agent does. A bind mount of an arbitrary
// host path into a container the user has a root shell in is a host takeover:
// `/` gives them the machine, `/var/run/docker.sock` gives them every other
// container, `~/.ssh` gives them the keys. So the path is not merely "checked" —
// it must resolve inside an explicitly configured root, and the check happens on
// the *resolved real path*, after symlinks, because `/srv/import/evil -> /` is a
// string that passes any prefix test performed before resolution.
//
// Pure: the filesystem is injected, so the escape cases are unit-tested without
// creating symlinks on a real disk.

/** Thrown when a requested import path is not one this node will mount. */
export class ImportPathError extends Error {}

/**
 * Whether `target` is `root` itself or lives beneath it.
 *
 * Compares path segments rather than string prefixes: `/srv/import-evil`
 * starts with `/srv/import` as a string, and is not inside it.
 */
export function isContained(root: string, target: string): boolean {
  const from = path.resolve(root);
  const to = path.resolve(target);
  if (from === to) return true;
  const rel = path.relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface ResolveImportDeps {
  /** Resolve symlinks; rejects when the path does not exist. */
  realpath: (p: string) => Promise<string>;
  /** The configured allowlist root, or undefined when importing is switched off. */
  root?: string;
}

/**
 * Turn a requested host path into one this node is willing to mount, or explain
 * why it will not.
 *
 * Resolving first and checking second is the whole point: the check has to apply
 * to the directory that will actually be mounted, not to the string that was
 * asked for.
 */
export async function resolveImportPath(requested: string, deps: ResolveImportDeps): Promise<string> {
  if (!deps.root) {
    throw new ImportPathError('importing directories is not enabled on this node (set IMPORT_ROOT)');
  }
  if (typeof requested !== 'string' || !requested.trim()) {
    throw new ImportPathError('a directory path is required');
  }

  // An absolute path is required: a relative one would resolve against whatever
  // the agent's working directory happens to be, which is not a decision anyone
  // is making deliberately.
  const candidate = requested.trim();
  if (!path.isAbsolute(candidate)) {
    throw new ImportPathError('the directory must be an absolute path');
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = await deps.realpath(deps.root);
  } catch {
    throw new ImportPathError(`the configured import root ${deps.root} does not exist on this node`);
  }

  let resolved: string;
  try {
    resolved = await deps.realpath(candidate);
  } catch {
    // Deliberately does not distinguish "missing" from "no permission": either
    // way the answer is the same, and the difference probes the host filesystem.
    throw new ImportPathError(`${candidate} does not exist on this node`);
  }

  if (!isContained(resolvedRoot, resolved)) {
    throw new ImportPathError(`${candidate} is outside the import root ${deps.root}`);
  }
  return resolved;
}

/** The node's configured import root, or undefined when the feature is off. */
export function importRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.IMPORT_ROOT?.trim();
  return value ? value : undefined;
}

/**
 * Internal HTTP so the Orchestrator can check a path *before* creating a
 * deployment — only this node can see its own filesystem, so only this node can
 * answer. The agent checks again at start; this exists so the person gets the
 * error while filling in the form rather than as a crashed server.
 */
export function createImportRouter(deps: ResolveImportDeps): Router {
  const router = Router();

  router.get('/imports', (_req: Request, res: Response) => {
    res.json({ enabled: Boolean(deps.root), root: deps.root ?? null });
  });

  router.post('/imports/resolve', async (req: Request, res: Response) => {
    try {
      const resolved = await resolveImportPath(String((req.body ?? {}).path ?? ''), deps);
      res.json({ path: resolved });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
