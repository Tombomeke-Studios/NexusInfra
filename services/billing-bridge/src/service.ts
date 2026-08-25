import { randomUUID } from 'crypto';
import { buildEnvelope, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent, type ResourceLimits } from 'shared';
import { resourceFactor, roundCurrency, type BillingPlan } from './pricing.js';
import { accruedHours } from './tracking.js';
import { applyTopUp } from './wallet.js';
import type { CreditLedgerEntry, CreditWallet, Repository, ServerBillingRecord } from './types.js';

// The Billing Bridge service (hosted edition). Turns bus events into runtime
// intervals and credit movements, and drives the top-up flow to FinVault. All
// side effects (publishing, time) are injected so the whole thing is testable
// with the in-memory repo and a captured publisher — no broker needed.

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

// Routing key for the top-up charge sent to FinVault. FinVault binds the
// `bank.payment.#` namespace (see docs/architecture.md); the event `type` stays
// `payment.request` for wire-compatibility.
export const KEY_PAYMENT_REQUEST = 'bank.payment.request';

/** What we remember about a deployment so an interval can be opened for it later. */
interface DeploymentMeta {
  userId: string;
  planId: string;
  limits: ResourceLimits;
}

export interface BillingServiceDeps {
  repo: Repository;
  publish?: PublishFn;
  now?: () => string;
  /** NexusInfra's receiver wallet id on payment.request (FinVault resolves the sender). */
  billingWalletId?: string;
}

export interface TopUpResult {
  reference: string;
  entry: CreditLedgerEntry;
}

export function createBillingService(deps: BillingServiceDeps) {
  const { repo } = deps;
  const publish = deps.publish ?? publishRabbitEvent;
  const now = deps.now ?? (() => new Date().toISOString());
  const billingWalletId = deps.billingWalletId ?? process.env.BILLING_WALLET_ID ?? 'nexusinfra';

  // deploymentId → owner/plan/limits, learned from deployment.created. Falls back
  // to the latest stored interval if we missed the creation (e.g. after restart).
  const meta = new Map<string, DeploymentMeta>();

  const emit = (routingKey: string, event: NexusInfraEvent) => publish(routingKey, buildEnvelope('billing-bridge', event));

  async function resolveMeta(deploymentId: string, userId?: string): Promise<DeploymentMeta | null> {
    const cached = meta.get(deploymentId);
    if (cached) return cached;
    if (userId) {
      const intervals = await repo.listIntervals(userId);
      const last = intervals.filter((i) => i.deploymentId === deploymentId).at(-1);
      if (last) {
        const m: DeploymentMeta = { userId: last.userId, planId: last.planId, limits: last.limits };
        meta.set(deploymentId, m);
        return m;
      }
    }
    return null;
  }

  return {
    /** Learn a deployment's owner + resource limits so future starts can be billed. */
    async handleDeploymentCreated(payload: { deploymentId: string; userId: string; resourceLimits?: ResourceLimits }): Promise<void> {
      const plan = await repo.getUserPlan(payload.userId);
      meta.set(payload.deploymentId, { userId: payload.userId, planId: plan.id, limits: payload.resourceLimits ?? {} });
    },

    /** Open a runtime interval for a server that just started. */
    async handleServerStarted(payload: { deploymentId: string }): Promise<ServerBillingRecord | null> {
      const m = await resolveMeta(payload.deploymentId);
      if (!m) return null; // unknown deployment (never saw deployment.created) — skip
      return repo.openInterval({ userId: m.userId, deploymentId: payload.deploymentId, planId: m.planId, limits: m.limits, startedAt: now() });
    },

    /** Close the open interval for a server that stopped or crashed. */
    async handleServerStopped(payload: { deploymentId: string }): Promise<ServerBillingRecord | null> {
      return repo.closeInterval(payload.deploymentId, now());
    },

    /**
     * Start a credit top-up: record a pending ledger entry and ask FinVault to
     * charge the user (payment.request). Credit is added only on payment.confirmed.
     */
    async requestTopUp(userId: string, amount: number, currency?: string): Promise<TopUpResult> {
      if (!(amount > 0)) throw new Error('top-up amount must be positive');
      const wallet = await repo.getWallet(userId);
      const cur = currency ?? wallet.currency;
      const reference = `topup-${userId}-${randomUUID()}`;
      const entry = await repo.createLedgerEntry({
        userId,
        type: 'topup',
        amount,
        currency: cur,
        reference,
        status: 'pending',
        description: 'NexusInfra credit top-up',
      });
      await emit(KEY_PAYMENT_REQUEST, {
        type: 'payment.request',
        payload: { reference, senderWalletId: userId, receiverWalletId: billingWalletId, amount, currency: cur, description: 'NexusInfra credit top-up' },
      });
      return { reference, entry };
    },

    /** A top-up succeeded in FinVault: mark it confirmed and add the credit. */
    async handlePaymentConfirmed(payload: { reference: string; amount: number }): Promise<CreditWallet | null> {
      const entry = await repo.getLedgerByReference(payload.reference);
      if (!entry || entry.type !== 'topup' || entry.status !== 'pending') return null;
      await repo.updateLedgerStatus(entry.id, 'confirmed');
      const wallet = await repo.getWallet(entry.userId);
      return repo.setBalance(entry.userId, applyTopUp(wallet.balance, entry.amount));
    },

    /** A top-up failed in FinVault: mark it failed, no credit added. */
    async handlePaymentFailed(payload: { reference: string }): Promise<CreditLedgerEntry | null> {
      const entry = await repo.getLedgerByReference(payload.reference);
      if (!entry || entry.type !== 'topup' || entry.status !== 'pending') return null;
      return repo.updateLedgerStatus(entry.id, 'failed');
    },

    /**
     * Current usage summary for a user: accrued hours and projected cost. The
     * plan's monthly free-hour grant is a single pool spent across intervals
     * (cheapest-correct: consumed in interval order); each interval's billable
     * hours are then charged at its own resource factor.
     */
    async getUsage(userId: string): Promise<{ hours: number; cost: number; plan: BillingPlan }> {
      const [plan, intervals] = await Promise.all([repo.getUserPlan(userId), repo.listIntervals(userId)]);
      const at = now();
      let remainingFree = plan.freeHoursPerMonth;
      let cost = 0;
      let hours = 0;
      for (const i of intervals) {
        const h = accruedHours([{ startedAt: i.startedAt, stoppedAt: i.stoppedAt }], at);
        hours += h;
        const freeApplied = Math.min(remainingFree, h);
        remainingFree -= freeApplied;
        const billable = h - freeApplied;
        cost += billable * plan.pricePerHour * resourceFactor(i.limits);
      }
      return { hours: Math.round(hours * 1000) / 1000, cost: roundCurrency(cost), plan };
    },

    /** Expose the resource factor for a set of limits (handy for UIs/quotes). */
    quote(limits: ResourceLimits): number {
      return resourceFactor(limits);
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
