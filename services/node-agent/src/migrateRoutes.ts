import os from 'os';
import path from 'path';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';
import { backupFilePath, isSafeRef } from './backups.js';
import { isDeploymentId } from './volumes.js';

// Moving a server between nodes (#234) — the node-side half. The orchestrator
// streams each volume from the source's export straight into the target's
// import, so a world of several gigabytes never sits in anybody's memory.
//
// Both directions refuse to overwrite. Two agents pointed at one Docker daemon
// share its volumes, and a migration between them that "imported" over the
// source and then cleaned the source up would delete the only copy.

function absolute(p: unknown): string | null {
  if (typeof p !== 'string' || !p.startsWith('/') || p.split('/').includes('..')) return null;
  return p;
}

export function createMigrationRouter(runtime: ContainerRuntime, opts: { backupDir?: string } = {}): Router {
  const backupDir = opts.backupDir ?? process.env.BACKUP_DIR ?? path.join(os.tmpdir(), 'nexusinfra-backups');
  const router = Router();

  router.use('/deployments/:id/volumes', (req: Request, res: Response, next) => {
    if (!isDeploymentId(req.params.id)) return res.status(400).json({ error: 'invalid deployment id' });
    next();
  });

  router.get('/deployments/:id/volumes', async (req: Request, res: Response) => {
    try {
      return res.json(await runtime.listDeploymentVolumes(req.params.id));
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'could not list volumes' });
    }
  });

  router.get('/deployments/:id/volumes/export', async (req: Request, res: Response) => {
    const volumePath = absolute(req.query.path);
    const image = typeof req.query.image === 'string' ? req.query.image : '';
    if (!volumePath || !image) return res.status(400).json({ error: 'an absolute path and the server image are required' });
    try {
      const tar = await runtime.exportVolume(req.params.id, volumePath, image);
      res.setHeader('content-type', 'application/x-tar');
      await pipeline(tar, res);
    } catch (err) {
      if (!res.headersSent) return res.status(500).json({ error: err instanceof Error ? err.message : 'export failed' });
      res.destroy(err instanceof Error ? err : undefined);
    }
  });

  router.put('/deployments/:id/volumes/import', async (req: Request, res: Response) => {
    const volumePath = absolute(req.query.path);
    const image = typeof req.query.image === 'string' ? req.query.image : '';
    if (!volumePath || !image) return res.status(400).json({ error: 'an absolute path and the server image are required' });
    try {
      await runtime.importVolume(req.params.id, volumePath, image, req);
      return res.status(201).json({ imported: volumePath });
    } catch (err) {
      const exists = (err as { code?: string }).code === 'EEXIST';
      return res.status(exists ? 409 : 500).json({ error: err instanceof Error ? err.message : 'import failed' });
    }
  });

  // Only for undoing an import this migration made; everything else about a
  // server's data goes with the server (DELETE /deployments/:id/data).
  router.delete('/deployments/:id/volumes', async (req: Request, res: Response) => {
    const volumePath = absolute(req.query.path);
    if (!volumePath) return res.status(400).json({ error: 'an absolute path is required' });
    try {
      await runtime.removeDeploymentVolume(req.params.id, volumePath);
      return res.status(204).end();
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'could not remove the volume' });
    }
  });

  // Receive a backup tar from another node. Refuses an existing ref, for the same
  // reason the volume import does.
  router.put('/backups/:ref', async (req: Request, res: Response) => {
    if (!isSafeRef(req.params.ref)) return res.status(400).json({ error: 'invalid backup reference' });
    const file = backupFilePath(backupDir, req.params.ref);
    try {
      await fs.mkdir(backupDir, { recursive: true });
      await pipeline(req, createWriteStream(file, { flags: 'wx' }));
      return res.status(201).json({ ref: req.params.ref });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') return res.status(409).json({ error: 'this node already has that backup' });
      await fs.unlink(file).catch(() => undefined);
      return res.status(500).json({ error: err instanceof Error ? err.message : 'could not store the backup' });
    }
  });

  return router;
}
