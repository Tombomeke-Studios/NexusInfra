import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';
import { buildDatabaseSpec, pickDatabasePort, type DatabaseEngine } from './databases.js';

// Internal database-provisioning HTTP (#109), reached only via the Orchestrator's
// proxy. Provisioning starts a fresh engine container; deprovisioning stops and
// removes it. Credentials are chosen by the Orchestrator and passed in.

const ENGINES: DatabaseEngine[] = ['mysql', 'mariadb', 'postgres'];

export function createDatabaseRouter(runtime: ContainerRuntime, pickPort: () => number = pickDatabasePort): Router {
  const router = Router();

  router.post('/databases', async (req: Request, res: Response) => {
    const { engine, name, username, password } = req.body ?? {};
    if (!ENGINES.includes(engine) || !name || !username || !password) {
      return res.status(400).json({ error: 'engine, name, username and password are required' });
    }
    const hostPort = pickPort();
    try {
      const containerId = await runtime.start(buildDatabaseSpec({ engine, name, username, password, hostPort }));
      res.status(201).json({ containerId, port: hostPort });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/databases/:containerId', async (req: Request, res: Response) => {
    try {
      await runtime.stop(req.params.containerId);
      res.status(204).end();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
