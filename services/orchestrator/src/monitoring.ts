import { Router, type Request, type Response } from 'express';

// Surfaces the Control Room's live monitoring snapshot to the dashboard (#157).
// The dashboard talks only to the Orchestrator (/api), so it can't reach the
// Control Room (:9000) directly; this proxies its /status. If the Control Room is
// unreachable we answer 200 with `reachable: false` so the panel can show it as
// down instead of erroring the whole Overview.

const CONTROL_ROOM_URL = process.env.CONTROL_ROOM_URL || 'http://control-room:9000';

export function createMonitoringRouter(): Router {
  const router = Router();

  router.get('/monitoring', async (_req: Request, res: Response) => {
    try {
      const r = await fetch(`${CONTROL_ROOM_URL}/status`);
      if (!r.ok) return res.json({ monitored: [], reachable: false });
      const body = (await r.json()) as Record<string, unknown>;
      return res.json({ ...body, reachable: true });
    } catch {
      return res.json({ monitored: [], reachable: false });
    }
  });

  return router;
}
