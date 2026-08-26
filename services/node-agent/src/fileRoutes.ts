import { Router, raw, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';

// Internal file-management HTTP for a container (#108), reached only via the
// Orchestrator's proxy on the private network. Every handler is thin: it turns a
// request into a ContainerRuntime call and maps failures to 400 (the runtime
// throws with the container's own error message, e.g. "No such file").

/**
 * Cap on a single upload. The file is held in memory as a Buffer and again inside
 * the tar, so an unbounded upload is an out-of-memory crash of the agent.
 */
const MAX_UPLOAD_BYTES = process.env.MAX_UPLOAD_BYTES || '64mb';

const fail = (res: Response, err: unknown) =>
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });

export function createFileRouter(runtime: ContainerRuntime): Router {
  const router = Router();

  // List a directory.
  router.get('/files/:containerId', async (req: Request, res: Response) => {
    try {
      res.json(await runtime.listFiles(req.params.containerId, String(req.query.path ?? '/')));
    } catch (err) {
      fail(res, err);
    }
  });

  // Read a file's contents.
  router.get('/files/:containerId/content', async (req: Request, res: Response) => {
    const path = String(req.query.path ?? '');
    if (!path) return res.status(400).json({ error: 'path is required' });
    try {
      res.json({ path, content: await runtime.readFile(req.params.containerId, path) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Create or overwrite a file.
  router.put('/files/:containerId/content', async (req: Request, res: Response) => {
    const { path, content } = req.body ?? {};
    if (typeof path !== 'string' || !path) return res.status(400).json({ error: 'path is required' });
    try {
      await runtime.writeFile(req.params.containerId, path, typeof content === 'string' ? content : '');
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // Create or overwrite a file from raw bytes — the upload path (#263). Reading a
  // file as text and re-encoding it loses every byte that is not valid UTF-8, so
  // uploads travel as octet-stream all the way to putArchive.
  router.put(
    '/files/:containerId/binary',
    raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
      const path = String(req.query.path ?? '');
      if (!path) return res.status(400).json({ error: 'path is required' });
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        await runtime.writeFileBytes(req.params.containerId, path, data);
        res.status(204).end();
      } catch (err) {
        fail(res, err);
      }
    }
  );

  // Make a directory.
  router.post('/files/:containerId/dir', async (req: Request, res: Response) => {
    const { path } = req.body ?? {};
    if (typeof path !== 'string' || !path) return res.status(400).json({ error: 'path is required' });
    try {
      await runtime.makeDir(req.params.containerId, path);
      res.status(201).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // Move / rename.
  router.post('/files/:containerId/rename', async (req: Request, res: Response) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) {
      return res.status(400).json({ error: 'from and to are required' });
    }
    try {
      await runtime.renamePath(req.params.containerId, from, to);
      res.status(200).json({ from, to });
    } catch (err) {
      fail(res, err);
    }
  });

  // Delete a file or directory.
  router.delete('/files/:containerId', async (req: Request, res: Response) => {
    const path = String(req.query.path ?? '');
    if (!path) return res.status(400).json({ error: 'path is required' });
    try {
      await runtime.deletePath(req.params.containerId, path);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
