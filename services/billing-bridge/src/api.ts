import { Router, type Request, type Response } from 'express';
import { withinQuota, type QuotaResource } from './quotas.js';
import type { BillingService } from './service.js';
import type { Repository } from './types.js';

// HTTP API for the Billing Bridge (hosted edition). The dashboard's Billing page
// (#149) reads wallet/usage/ledger and posts top-ups; the Orchestrator (#148)
// checks quotas here. Identity is the FinVault userId (path param for now; the
// gateway will bind it from the JWT later).

export interface BillingApiDeps {
  repo: Repository;
  service: BillingService;
}

export function createBillingRouter({ repo, service }: BillingApiDeps): Router {
  const router = Router();

  router.get('/billing/:userId/wallet', async (req: Request, res: Response) => {
    res.json(await repo.getWallet(req.params.userId));
  });

  router.get('/billing/:userId/usage', async (req: Request, res: Response) => {
    res.json(await service.getUsage(req.params.userId));
  });

  router.get('/billing/:userId/ledger', async (req: Request, res: Response) => {
    res.json(await repo.listLedger(req.params.userId));
  });

  router.get('/billing/:userId/plan', async (req: Request, res: Response) => {
    res.json(await repo.getUserPlan(req.params.userId));
  });

  // Quota check for the Orchestrator: is creating one more `resource` allowed
  // given the user already has `current`? Returns { allowed, limit }.
  router.get('/billing/:userId/quota', async (req: Request, res: Response) => {
    const resource = req.query.resource as QuotaResource;
    if (resource !== 'servers' && resource !== 'databases') {
      return res.status(400).json({ error: 'resource must be servers or databases' });
    }
    const current = Number(req.query.current ?? 0);
    if (!Number.isFinite(current) || current < 0) {
      return res.status(400).json({ error: 'current must be a non-negative number' });
    }
    const plan = await repo.getUserPlan(req.params.userId);
    const limit = resource === 'servers' ? plan.maxServers : plan.maxDatabases;
    return res.json({ allowed: withinQuota(plan, resource, current), limit });
  });

  // Start a credit top-up (funded via FinVault). Credit is added on
  // payment.confirmed, not here.
  router.post('/billing/:userId/topup', async (req: Request, res: Response) => {
    const { amount, currency } = req.body ?? {};
    if (typeof amount !== 'number' || !(amount > 0)) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    try {
      const { reference, entry } = await service.requestTopUp(req.params.userId, amount, typeof currency === 'string' ? currency : undefined);
      return res.status(202).json({ status: 'pending', reference, entry });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'top-up failed' });
    }
  });

  return router;
}
