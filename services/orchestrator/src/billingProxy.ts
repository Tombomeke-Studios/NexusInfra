import { Router, type Request, type Response } from 'express';

// Authenticated billing proxy (hosted edition). The dashboard talks only to the
// Orchestrator (/api); these routes forward to the Billing Bridge, injecting the
// caller's authenticated userId from the JWT so the client never passes a user id
// itself. Mounted after requireAuth.

const BILLING_BRIDGE_URL = process.env.BILLING_BRIDGE_URL || 'http://billing-bridge:9300';

function userIdOf(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? 'dev-user';
}

export function createBillingProxyRouter(): Router {
  const router = Router();

  const forward = async (req: Request, res: Response, path: string, init?: RequestInit) => {
    try {
      const r = await fetch(`${BILLING_BRIDGE_URL}/billing/${encodeURIComponent(userIdOf(req))}${path}`, init);
      const body = await r.text();
      res.status(r.status);
      return body ? res.type('application/json').send(body) : res.end();
    } catch {
      return res.status(502).json({ error: 'billing service unreachable' });
    }
  };

  router.get('/billing/wallet', (req, res) => forward(req, res, '/wallet'));
  router.get('/billing/usage', (req, res) => forward(req, res, '/usage'));
  router.get('/billing/ledger', (req, res) => forward(req, res, '/ledger'));
  router.get('/billing/plan', (req, res) => forward(req, res, '/plan'));
  router.post('/billing/topup', (req, res) =>
    forward(req, res, '/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body ?? {}) })
  );

  return router;
}
