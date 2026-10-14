import { Router, type Request, type Response } from 'express';

// Authenticated billing proxy (hosted edition). The dashboard talks only to the
// Orchestrator (/api); these routes forward to the Billing Bridge, injecting the
// caller's authenticated userId from the JWT so the client never passes a user id
// itself. Mounted after requireAuth.

const BILLING_BRIDGE_URL = process.env.BILLING_BRIDGE_URL || 'http://billing-bridge:9300';

function userIdOf(req: Request): string | undefined {
  return (req as Request & { userId?: string }).userId;
}

export interface BillingProxyDeps {
  /**
   * The signed-in account's email address — who FinVault asks to pay a top-up
   * (#351). Looked up here from the authenticated user; an address in the
   * request body is never used, or a caller could send a payment request to
   * anybody's FinVault inbox.
   */
  emailOf?(userId: string): Promise<string | null>;
}

export function createBillingProxyRouter(deps: BillingProxyDeps = {}): Router {
  const router = Router();

  // Every route here acts for one account. There used to be a 'dev-user'
  // fallback, which would have shared one wallet between all callers had a
  // request ever arrived unauthenticated.
  router.use('/billing', (req, res, next) => (userIdOf(req) ? next() : res.status(401).json({ error: 'authentication required' })));

  const forward = async (req: Request, res: Response, path: string, init?: RequestInit) => {
    try {
      const r = await fetch(`${BILLING_BRIDGE_URL}/billing/${encodeURIComponent(userIdOf(req) as string)}${path}`, init);
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
  router.post('/billing/topup', async (req, res) => {
    const email = await deps.emailOf?.(userIdOf(req) as string);
    if (!email) return res.status(409).json({ error: 'this account has no email address for FinVault to ask for payment' });
    const { amount, currency } = (req.body ?? {}) as { amount?: unknown; currency?: unknown };
    return forward(req, res, '/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount, currency, email }) });
  });

  return router;
}
