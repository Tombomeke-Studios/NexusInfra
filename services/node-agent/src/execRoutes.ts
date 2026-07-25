import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';

// Internal console HTTP (#68), reached only via the Orchestrator's proxy. Runs a
// one-shot command in the container via `sh -c` and returns its combined output.
// The user runs commands in their own container, so a shell string is the intent.
export function createExecRouter(runtime: ContainerRuntime): Router {
  const router = Router();

  router.post('/exec/:containerId', async (req: Request, res: Response) => {
    const { command } = req.body ?? {};
    if (typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: 'command is required' });
    }
    try {
      const { stdout, stderr, exitCode } = await runtime.execCommand(req.params.containerId, ['sh', '-c', command]);
      res.json({ stdout, stderr, exitCode });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
