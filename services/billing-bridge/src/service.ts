import { randomUUID } from 'crypto';
import { buildEnvelope, publishRabbitEvent, type EventEnvelope, type NexusInfraEvent, type ResourceLimits } from 'shared';
import { resourceFactor, type BillingPlan } from './pricing.js';
import { computeStanding, currentPeriod, usageIn, type Standing } from './standing.js';
import { applyTopUp } from './wallet.js';
import type { BilledDeployment, CreditLedgerEntry, CreditWallet, Repository, ServerBillingRecord } from './types.js';

// The Billing Bridge service (hosted edition). Turns bus events into runtime
// intervals and credit movements, and drives the top-up flow to FinVault. All
// side effects (publishing, time) are injected so the whole thing is testable
// with the in-memory repo and a captured publisher — no broker needed.

export type PublishFn = (routingKey: string, envelope: EventEnvelope) => Promise<boolean>;

// Routing key for the top-up charge sent to FinVault. FinVault binds the
// `bank.payment.#` namespace (see docs/architecture.md); the event `type` stays
// `payment.request` for wire-compatibility.
export const KEY_PAYMENT_REQUEST = 'bank.payment.request';
const KEY_SUSPEND = 'billing.server.suspend';

/** How often running accounts are checked against their balance (#365). */
export const DEFAULT_SETTLE_INTERVAL_MS = 5 * 60 * 1000;

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

/**
 * How many top-ups one account may have waiting on FinVault (#351). Each one is
 * a payment request in somebody's FinVault inbox, addressed by an email this
 * side has not verified.
 */
export const MAX_PENDING_TOPUPS = 3;

/** A top-up that was refused before anything was sent; `status` is the HTTP answer. */
export class TopUpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const REASON_MAX = 300;

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

  const emit = (routingKey: string, event: NexusInfraEvent) => publish(routingKey, buildEnvelope('billing-bridge', event));

  /**
   * Who owns a deployment and how big it is. Stored, not remembered: this used
   * to be a map in memory, so after any restart every server started later ran
   * unbilled (#364). A server from before that is recognised by its last interval.
   */
  async function deploymentFor(deploymentId: string): Promise<BilledDeployment | null> {
    const known = await repo.getDeployment(deploymentId);
    if (known) return known;
    const last = await repo.getLastInterval(deploymentId);
    if (!last) return null;
    const recovered: BilledDeployment = { deploymentId, userId: last.userId, limits: last.limits };
    await repo.saveDeployment(recovered);
    return recovered;
  }

  return {
    /** Record a deployment's owner + resource limits so its runtime can be billed. Also handles a resize. */
    async handleDeploymentCreated(payload: { deploymentId: string; userId: string; resourceLimits?: ResourceLimits }): Promise<void> {
      await repo.saveDeployment({ deploymentId: payload.deploymentId, userId: payload.userId, limits: payload.resourceLimits ?? {} });
    },

    /**
     * Open a runtime interval for a server that just started. A server that
     * already has one running keeps it: a start reported twice (the broker
     * delivers at least once, and an agent re-reports after its own restart) used
     * to open a second interval that nothing would ever close.
     */
    async handleServerStarted(payload: { deploymentId: string }): Promise<ServerBillingRecord | null> {
      const deployment = await deploymentFor(payload.deploymentId);
      if (!deployment) {
        log(`server ${payload.deploymentId} started but billing has never heard of it; it is not being charged`);
        return null;
      }
      const running = await repo.getOpenInterval(payload.deploymentId);
      if (running) return running;
      const plan = await repo.getUserPlan(deployment.userId);
      return repo.openInterval({ userId: deployment.userId, deploymentId: payload.deploymentId, planId: plan.id, limits: deployment.limits, startedAt: now() });
    },

    /** Close the open interval for a server that stopped or crashed. */
    async handleServerStopped(payload: { deploymentId: string }): Promise<ServerBillingRecord | null> {
      return repo.closeInterval(payload.deploymentId, now());
    },

    /**
     * Start a credit top-up: record a pending ledger entry and ask FinVault to
     * charge the user (payment.request). Credit is added only on payment.confirmed.
     *
     * `customerEmail` is who FinVault asks to pay (#351) — the account's own
     * address, supplied by the Orchestrator from the signed-in user, never by the
     * browser.
     */
    async requestTopUp(userId: string, amount: number, currency?: string, customerEmail?: string): Promise<TopUpResult> {
      if (!(amount > 0)) throw new TopUpError('top-up amount must be positive', 400);
      const waiting = (await repo.listLedger(userId)).filter((e) => e.type === 'topup' && e.status === 'pending').length;
      if (waiting >= MAX_PENDING_TOPUPS) {
        throw new TopUpError(`you already have ${waiting} top-ups waiting to be approved in FinVault — pay or decline one there first`, 409);
      }
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
      const sent = await emit(KEY_PAYMENT_REQUEST, {
        type: 'payment.request',
        payload: {
          reference,
          senderWalletId: userId,
          receiverWalletId: billingWalletId,
          amount,
          currency: cur,
          description: 'NexusInfra credit top-up',
          ...(customerEmail ? { customerEmail } : {}),
        },
      });
      if (!sent) {
        // The broker did not take it, so FinVault will never see this request.
        // Saying so now beats thirty minutes of "pending" for nothing.
        const reason = 'the request could not be sent to FinVault';
        await repo.transitionLedgerStatus(entry.id, ['pending'], 'failed', reason);
        throw new TopUpError(`${reason} — nothing was charged, try again in a moment`, 503);
      }
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

    /** A top-up failed in FinVault: mark it failed with FinVault's reason, no credit added. */
    async handlePaymentFailed(payload: { reference: string; reason?: string }): Promise<CreditLedgerEntry | null> {
      const entry = await repo.getLedgerByReference(payload.reference);
      if (!entry || entry.type !== 'topup') return null;
      const failureReason = typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason.trim().slice(0, REASON_MAX) : null;
      if (!(await repo.transitionLedgerStatus(entry.id, ['pending', 'expired'], 'failed', failureReason ?? undefined))) return null;
      return { ...entry, status: 'failed', failureReason };
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
     * This cycle's usage so far: hours run and what they will cost. Computed with
     * the function the cycle runner charges with, over the month in progress — it
     * used to sum every interval an account ever had, so the figure only grew and
     * stopped matching the bill after the first month (#366).
     */
    async getUsage(userId: string): Promise<{ hours: number; cost: number; plan: BillingPlan }> {
      const [plan, intervals] = await Promise.all([repo.getUserPlan(userId), repo.listIntervals(userId)]);
      return { ...usageIn(intervals, plan, currentPeriod(now())), plan };
    },

    /** What the account has left to spend, and whether it may run servers (#365). */
    async getStanding(userId: string): Promise<Standing> {
      const [plan, intervals, wallet, cycles] = await Promise.all([repo.getUserPlan(userId), repo.listIntervals(userId), repo.getWallet(userId), repo.listCycles(userId)]);
      return computeStanding({ balance: wallet.balance, currency: wallet.currency, intervals, cycles, plan, now: now() });
    },

    /**
     * Stop the servers of every account that has used up what it had (#365).
     * Nothing is charged here — the monthly cycle still does that — this only
     * stops usage from running past the balance while the month is open. Safe to
     * repeat: once the servers stop there is nothing running to suspend.
     */
    async settle(): Promise<Array<{ userId: string; deploymentIds: string[] }>> {
      const suspended: Array<{ userId: string; deploymentIds: string[] }> = [];
      for (const userId of await repo.listBillableUserIds()) {
        const running = [...new Set((await repo.listIntervals(userId)).filter((i) => i.stoppedAt === null).map((i) => i.deploymentId))];
        if (running.length === 0) continue;
        const standing = await this.getStanding(userId);
        if (standing.canRun) continue;
        await emit(KEY_SUSPEND, { type: 'billing.server.suspend', payload: { userId, deploymentIds: running, reason: 'credit exhausted' } });
        suspended.push({ userId, deploymentIds: running });
      }
      if (suspended.length > 0) log(`suspended the servers of ${suspended.length} account(s) that ran out of credit`);
      return suspended;
    },

    /** Expose the resource factor for a set of limits (handy for UIs/quotes). */
    quote(limits: ResourceLimits): number {
      return resourceFactor(limits);
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
