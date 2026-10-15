import { Router, type Request, type Response } from 'express';
import { principalOf, requirePlatformAdmin } from './auth.js';
import { bridgeFetch } from './bridge.js';
import { usageFor, type EntitlementUsage } from './entitlements.js';
import type { Repository } from './types.js';

// Plans a customer chooses between, and the provider's view of their customers
// (#369) — hosted edition. The Billing Bridge owns plans and money; the
// Orchestrator owns accounts and servers, so it is the one that can say who is
// asking, whether they may, and whether what they have fits what they picked.
//
// Two audiences, two prefixes:
//   /billing/plans, /billing/plan     any signed-in account, about itself
//   /billing/admin/…                  platform administrators, about everyone

/** A plan as the Billing Bridge serves it. */
export interface Plan {
  id: string;
  name: string;
  pricePerHour: number;
  currency: string;
  freeHoursPerMonth: number;
  maxServers: number;
  maxDatabases: number;
  maxRamMb: number | null;
  maxBackupsPerServer: number | null;
  active: boolean;
}

/** One account as the bridge summarises it. */
interface BridgeAccount {
  userId: string;
  planId: string;
  planName: string;
  balance: number;
  available: number;
  canRun: boolean;
  currency: string;
  hours: number;
  cost: number;
  runningServers: number;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Why an account's servers do not fit `plan`, or null (pure). Checked before a
 * switch: moving to a smaller plan while holding more than it allows would
 * leave the account over its ceilings with nothing having refused anything.
 */
export function planFitProblem(plan: Pick<Plan, 'name' | 'maxServers' | 'maxDatabases' | 'maxRamMb'>, usage: EntitlementUsage): string | null {
  if (usage.servers > plan.maxServers) {
    return `you have ${count(usage.servers, 'server')} and the ${plan.name} plan allows ${plan.maxServers} — delete ${count(usage.servers - plan.maxServers, 'server')} first`;
  }
  if (usage.databases > plan.maxDatabases) {
    return `you have ${count(usage.databases, 'database')} and the ${plan.name} plan allows ${plan.maxDatabases} — delete ${count(usage.databases - plan.maxDatabases, 'database')} first`;
  }
  if (plan.maxRamMb != null) {
    if (usage.uncappedServers > 0) {
      return `the ${plan.name} plan has a memory ceiling, and ${count(usage.uncappedServers, 'server')} of yours ${usage.uncappedServers === 1 ? 'has' : 'have'} no memory limit — give ${usage.uncappedServers === 1 ? 'it' : 'them'} one first`;
    }
    if (usage.ramMb > plan.maxRamMb) {
      return `your servers hold ${gb(usage.ramMb)} of memory and the ${plan.name} plan includes ${gb(plan.maxRamMb)} — lower their limits by ${gb(usage.ramMb - plan.maxRamMb)} first`;
    }
  }
  return null;
}

export interface BillingPlansDeps {
  repo: Repository;
}

export function createBillingPlansRouter({ repo }: BillingPlansDeps): Router {
  const router = Router();

  /** Relay a bridge response as it is; `502` when the bridge cannot be reached. */
  const relay = async (res: Response, path: string, init?: RequestInit) => {
    try {
      const r = await bridgeFetch(path, init);
      const body = await r.text();
      res.status(r.status);
      return body ? res.type('application/json').send(body) : res.end();
    } catch {
      return res.status(502).json({ error: 'billing service unreachable' });
    }
  };
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  /** The catalogue and one account's current plan id; null when the bridge cannot be asked. */
  async function catalogueFor(userId: string): Promise<{ plans: Plan[]; currentPlanId: string } | null> {
    try {
      const [plans, current] = await Promise.all([bridgeFetch('/plans'), bridgeFetch(`/billing/${encodeURIComponent(userId)}/plan`)]);
      if (!plans.ok || !current.ok) return null;
      return { plans: (await plans.json()) as Plan[], currentPlanId: ((await current.json()) as Plan).id };
    } catch {
      return null;
    }
  }

  async function usageOf(userId: string): Promise<EntitlementUsage> {
    const deployments = await repo.listDeployments();
    let databases = 0;
    for (const d of deployments) if (d.userId === userId) databases += (await repo.listDatabases(d.id)).length;
    return usageFor(userId, deployments, await repo.listNodes(), databases);
  }

  // ── A customer, about their own account ──────────────────────────────────

  // The plans on offer, plus the caller's own even when it has been retired —
  // they are still on it and should see what they are paying.
  router.get('/billing/plans', async (req: Request, res: Response) => {
    const catalogue = await catalogueFor(principalOf(req).id);
    if (!catalogue) return res.status(502).json({ error: 'billing service unreachable' });
    const usage = await usageOf(principalOf(req).id);
    return res.json({
      currentPlanId: catalogue.currentPlanId,
      plans: catalogue.plans
        .filter((p) => p.active || p.id === catalogue.currentPlanId)
        // Said up front, so the page can explain a plan that cannot be chosen
        // instead of offering a button that answers 409.
        .map((p) => ({ ...p, problem: p.id === catalogue.currentPlanId ? null : planFitProblem(p, usage) })),
    });
  });

  router.put('/billing/plan', async (req: Request, res: Response) => {
    const userId = principalOf(req).id;
    const planId = (req.body ?? {}).planId;
    if (typeof planId !== 'string' || !planId) return res.status(400).json({ error: 'planId is required' });
    const catalogue = await catalogueFor(userId);
    if (!catalogue) return res.status(502).json({ error: 'billing service unreachable' });
    const target = catalogue.plans.find((p) => p.id === planId);
    if (!target) return res.status(404).json({ error: 'no such plan' });
    if (target.id !== catalogue.currentPlanId) {
      const problem = planFitProblem(target, await usageOf(userId));
      if (problem) return res.status(409).json({ error: problem });
    }
    return relay(res, `/billing/${encodeURIComponent(userId)}/plan`, json('PUT', { planId }));
  });

  // ── The provider, about everyone ─────────────────────────────────────────

  router.get('/billing/admin/plans', requirePlatformAdmin, (_req, res) => relay(res, '/plans'));
  router.post('/billing/admin/plans', requirePlatformAdmin, (req, res) => relay(res, '/plans', json('POST', req.body)));
  router.put('/billing/admin/plans/:id', requirePlatformAdmin, (req, res) => relay(res, `/plans/${encodeURIComponent(req.params.id)}`, json('PUT', req.body)));

  // Every account in the panel, with what billing knows about it. Built from
  // the panel's accounts rather than the bridge's list, so a customer who has
  // registered and done nothing yet is still on the page.
  router.get('/billing/admin/accounts', requirePlatformAdmin, async (_req: Request, res: Response) => {
    let known: BridgeAccount[];
    let plans: Plan[];
    try {
      const [accounts, catalogue] = await Promise.all([bridgeFetch('/accounts'), bridgeFetch('/plans')]);
      if (!accounts.ok || !catalogue.ok) throw new Error('bridge refused');
      known = (await accounts.json()) as BridgeAccount[];
      plans = (await catalogue.json()) as Plan[];
    } catch {
      return res.status(502).json({ error: 'billing service unreachable' });
    }
    const byUser = new Map(known.map((a) => [a.userId, a]));
    const fallback = plans.find((p) => p.id === 'standard') ?? plans[0];
    const deployments = await repo.listDeployments();
    const users = await repo.listUsers();
    return res.json(
      users.map((user) => {
        const billing = byUser.get(user.id);
        return {
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          platformRole: user.platformRole,
          createdAt: user.createdAt,
          servers: deployments.filter((d) => d.userId === user.id).length,
          planId: billing?.planId ?? fallback?.id ?? null,
          planName: billing?.planName ?? fallback?.name ?? null,
          balance: billing?.balance ?? 0,
          available: billing?.available ?? 0,
          canRun: billing?.canRun ?? null,
          currency: billing?.currency ?? fallback?.currency ?? 'EUR',
          hours: billing?.hours ?? 0,
          cost: billing?.cost ?? 0,
          runningServers: billing?.runningServers ?? 0,
        };
      })
    );
  });

  // An administrator moving an account is not held to what the account's
  // servers fit: it is the provider's call, and the new plan's ceilings apply to
  // whatever the account does next. The plan still has to be on offer.
  router.put('/billing/admin/accounts/:userId/plan', requirePlatformAdmin, async (req: Request, res: Response) => {
    const user = await repo.getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'no such account' });
    const planId = (req.body ?? {}).planId;
    if (typeof planId !== 'string' || !planId) return res.status(400).json({ error: 'planId is required' });
    return relay(res, `/billing/${encodeURIComponent(user.id)}/plan`, json('PUT', { planId }));
  });

  // Credit added or removed by hand. `by` is the administrator doing it, taken
  // from the session — it is written into the customer's payment history.
  router.post('/billing/admin/accounts/:userId/credit', requirePlatformAdmin, async (req: Request, res: Response) => {
    const user = await repo.getUser(req.params.userId);
    if (!user) return res.status(404).json({ error: 'no such account' });
    const admin = await repo.getUser(principalOf(req).id);
    const { amount, reason } = (req.body ?? {}) as { amount?: unknown; reason?: unknown };
    return relay(res, `/billing/${encodeURIComponent(user.id)}/adjust`, json('POST', { amount, reason, by: admin?.email ?? 'an administrator' }));
  });

  return router;
}
