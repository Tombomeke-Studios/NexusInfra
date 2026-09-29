import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';
import { backupRef, backupFilePath, isSafeRef, DEFAULT_BACKUP_PATH } from './backups.js';
import { offsiteFromEnv, S3Target } from './s3.js';

// Internal backup HTTP (#110), reached only via the Orchestrator's proxy. A backup
// is a tar snapshot of a container path, written to the agent's backup directory
// under an opaque ref; restore reads it back and extracts it into the container.

/** The archive a backup names is gone — from the node, and from off-site if there is one. */
export class BackupMissingError extends Error {}

/** Where a backup's copy lives off the node, as recorded on the backup (#232). */
export type OffsiteState = 'stored' | 'failed' | null;

export function createBackupRouter(runtime: ContainerRuntime, opts: { dir?: string; offsite?: S3Target | null } = {}): Router {
  const dir = opts.dir ?? process.env.BACKUP_DIR ?? path.join(os.tmpdir(), 'nexusinfra-backups');
  // Off-site is optional and per node (#232): configured by env, off by default.
  const offsiteConfig = opts.offsite === undefined ? offsiteFromEnv() : null;
  const offsite = opts.offsite !== undefined ? opts.offsite : offsiteConfig ? new S3Target(offsiteConfig) : null;
  const router = Router();

  /**
   * A backup's tar: the node's copy, or the off-site one when the node's is gone.
   * The second half is the point of off-site — a node that lost its disk can
   * still restore what it had.
   *
   * A missing archive is a `BackupMissingError` with a message fit for a person
   * (#339). The filesystem's own error names the node's backup directory, and it
   * used to travel unchanged to the browser: a host path for anyone allowed to
   * download a backup, and no hint of what actually went wrong.
   */
  const readTar = async (ref: string): Promise<Buffer> => {
    const file = backupFilePath(dir, ref);
    try {
      return await fs.readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!offsite) {
        console.warn(`[node-agent] backup ${ref}: ${file} is missing and no off-site store is configured`);
        throw new BackupMissingError("this node no longer has the backup's archive, and it has no off-site store to fetch it from", { cause: err });
      }
      const remote = await offsite.get(ref);
      if (!remote) {
        console.warn(`[node-agent] backup ${ref}: ${file} is missing, and so is the off-site copy`);
        throw new BackupMissingError("the backup's archive is on neither this node nor the off-site store", { cause: err });
      }
      return remote;
    }
  };

  const fail = (res: Response, err: unknown) =>
    res.status(err instanceof BackupMissingError ? 404 : 400).json({ error: err instanceof Error ? err.message : String(err) });

  // Snapshot a container path → tar on disk. Returns the ref + size to record.
  router.post('/backups', async (req: Request, res: Response) => {
    const { containerId, path: p } = req.body ?? {};
    if (typeof containerId !== 'string' || !containerId) return res.status(400).json({ error: 'containerId is required' });
    const snapPath = typeof p === 'string' && p ? p : DEFAULT_BACKUP_PATH;
    try {
      const tar = await runtime.snapshotPath(containerId, snapPath);
      await fs.mkdir(dir, { recursive: true });
      const ref = backupRef();
      await fs.writeFile(backupFilePath(dir, ref), tar);

      // The local copy is written first and is the backup; the off-site copy is
      // a second one. A failed upload is reported on the record rather than
      // failing the backup — the snapshot did succeed, and saying it did not
      // would be as wrong as saying it is safe off-site.
      let offsiteState: OffsiteState = null;
      let offsiteError: string | undefined;
      if (offsite) {
        try {
          await offsite.put(ref, tar);
          offsiteState = 'stored';
        } catch (err) {
          offsiteState = 'failed';
          offsiteError = err instanceof Error ? err.message : String(err);
          console.warn(`[node-agent] backup ${ref} was kept on the node but not off-site: ${offsiteError}`);
        }
      }
      res.status(201).json({ ref, sizeBytes: tar.length, path: snapPath, offsite: offsiteState, ...(offsiteError ? { offsiteError } : {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Restore a stored tar back into the container.
  router.post('/backups/restore', async (req: Request, res: Response) => {
    const { containerId, ref, path: p } = req.body ?? {};
    if (typeof containerId !== 'string' || !containerId || typeof ref !== 'string' || !ref) {
      return res.status(400).json({ error: 'containerId and ref are required' });
    }
    try {
      const tar = await readTar(ref);
      await runtime.restoreArchive(containerId, typeof p === 'string' && p ? p : DEFAULT_BACKUP_PATH, tar);
      res.status(200).json({ restored: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Download a backup (#232) — the node's copy, or the off-site one.
  router.get('/backups/:ref/download', async (req: Request, res: Response) => {
    if (!isSafeRef(req.params.ref)) return res.status(400).json({ error: 'invalid backup reference' });
    try {
      const tar = await readTar(req.params.ref);
      res.setHeader('content-type', 'application/x-tar');
      res.setHeader('content-length', String(tar.length));
      return res.end(tar);
    } catch (err) {
      if (err instanceof BackupMissingError) return res.status(404).json({ error: err.message });
      console.warn(`[node-agent] backup ${req.params.ref} could not be read:`, err);
      return res.status(500).json({ error: 'the node could not read this backup' });
    }
  });

  // Delete a stored tar (idempotent — a missing file is fine), and its off-site copy.
  router.delete('/backups/:ref', async (req: Request, res: Response) => {
    try {
      await fs.unlink(backupFilePath(dir, req.params.ref)).catch(() => {});
      // Retention (#232) deletes through here, so a copy left behind off-site
      // would be a bill that grows forever for backups the panel says are gone.
      // `localOnly` is for a backup that moved to another node with its server
      // (#234): the off-site copy is still that backup's, and still wanted.
      if (offsite && req.query.localOnly !== 'true') await offsite.delete(req.params.ref);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
