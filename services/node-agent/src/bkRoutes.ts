import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';
import { backupRef, backupFilePath, DEFAULT_BACKUP_PATH } from './backups.js';

// Internal backup HTTP (#110), reached only via the Orchestrator's proxy. A backup
// is a tar snapshot of a container path, written to the agent's backup directory
// under an opaque ref; restore reads it back and extracts it into the container.

export function createBackupRouter(runtime: ContainerRuntime, opts: { dir?: string } = {}): Router {
  const dir = opts.dir ?? process.env.BACKUP_DIR ?? path.join(os.tmpdir(), 'nexusinfra-backups');
  const router = Router();

  const fail = (res: Response, err: unknown) => res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

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
      res.status(201).json({ ref, sizeBytes: tar.length, path: snapPath });
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
      const tar = await fs.readFile(backupFilePath(dir, ref));
      await runtime.restoreArchive(containerId, typeof p === 'string' && p ? p : DEFAULT_BACKUP_PATH, tar);
      res.status(200).json({ restored: true });
    } catch (err) {
      fail(res, err);
    }
  });

  // Delete a stored tar (idempotent — a missing file is fine).
  router.delete('/backups/:ref', async (req: Request, res: Response) => {
    try {
      await fs.unlink(backupFilePath(dir, req.params.ref)).catch(() => {});
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
