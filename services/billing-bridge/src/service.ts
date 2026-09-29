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
  log?: (message: string) => void;
}

/**
 * How long a top-up may wait for FinVault before it is shown as unconfirmed
 * (#298). A mismatched FINVAULT_MESSAGE_KEY, a FinVault that never received the
 * request, or one that answered on a key nobody binds all look the same from
 * here — silence — so silence has to end somewhere visible.
 */
export const DEFAULT_TOPUP_TIMEOUT_MS = 30 * 60 * 1000;

/** A confirmed amount "matches" to the cent: the ledger stores money, not floats. */
const sameAmount = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

export interface TopUpResult {
  reference: string;
  entry: CreditLedgerEntry;
}

export function createBillingService(deps: BillingServiceDeps) {
  const { repo } = deps;
  const publish = deps.publish ?? publishRabbitEvent;
  const now = deps.now ?? (() => new Date().toISOString());
  const billingWalletId = deps.billingWalletId ?? process.env.BILLING_WALLET_ID ?? 'nexusinfra';
  const log = deps.log ?? ((m: string) => console.warn(`[BillingBridge] ${m}`));

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

    /**
     * A top-up succeeded in FinVault: mark it confirmed and add the credit.
     *
     * The status change is conditional, so a confirmation delivered twice — which
     * an at-least-once broker is allowed to do — credits once. A late confirmation
     * of an expired top-up is still credited: the money moved.
     */
    async handlePaymentConfirmed(payload: { reference: string; amount?: number }): Promise<CreditWallet | null> {
      const entry = await repo.getLedgerByReference(payload.reference);
      // FinVault confirms every payment on one key, including ones that are none
      // of NexusInfra's business; an unknown reference is not an error.
      if (!entry || entry.type !== 'topup') return null;
      if (typeof payload.amount === 'number' && !sameAmount(payload.amount, entry.amount)) {
        // Neither amount can be trusted over the other, so nothing is credited
        // automatically — and the entry stays open for someone to look at.
        log(`top-up ${entry.reference} was confirmed for ${payload.amount} but requested for ${entry.amount}; not credited — check it by hand`);
        return null;
      }
      if (!(await repo.transitionLedgerStatus(entry.id, ['pending', 'expired'], 'confirmed'))) return null;
      if (entry.status === 'expired') log(`top-up ${entry.reference} was confirmed after it had expired; credited`);
      const wallet = await repo.getWallet(entry.userId);
      return repo.setBalance(entry.userId, applyTopUp(wallet.balance, entry.amount));
    },

    /** A top-up failed in FinVault: mark it failed, no credit added. */
    async handlePaymentFailed(payload: { reference: string }): Promise<CreditLedgerEntry | null> {
      const entry = await repo.getLedgerByReference(payload.reference);
      if (!entry || entry.type !== 'topup') return null;
      if (!(await repo.transitionLedgerStatus(entry.id, ['pending', 'expired'], 'failed'))) return null;
      return { ...entry, status: 'failed' };
    },

    /**
     * Mark top-ups FinVault has not answered within `timeoutMs` as expired (#298),
     * so the panel says "not confirmed" instead of "pending" forever. Returns the
     * ones it expired.
     */
    async expireStaleTopUps(timeoutMs = DEFAULT_TOPUP_TIMEOUT_MS): Promise<CreditLedgerEntry[]> {
      const cutoff = new Date(new Date(now()).getTime() - timeoutMs).toISOString();
      const expired: CreditLedgerEntry[] = [];
      for (const entry of await repo.listPendingTopUps(cutoff)) {
        if (await repo.transitionLedgerStatus(entry.id, ['pending'], 'expired')) expired.push({ ...entry, status: 'expired' });
      }
      if (expired.length > 0) {
        log(
          `${expired.length} top-up(s) had no answer from FinVault in ${Math.round(timeoutMs / 60000)} min and are now shown as not confirmed. ` +
            'If none are ever confirmed, check that FINVAULT_MESSAGE_KEY matches FinVault\'s and that both use the same broker.'
        );
      }
      return expired;
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
