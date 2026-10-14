import { randomUUID } from 'crypto';
import { DEFAULT_PLAN, type BillingPlan } from './pricing.js';
import type {
  BilledDeployment,
  BillingCycleRecord,
  CreateCycleInput,
  CreateLedgerInput,
  CreditLedgerEntry,
  CreditWallet,
  LedgerStatus,
  OpenIntervalInput,
  Repository,
  ServerBillingRecord,
} from './types.js';

// In-memory Repository — backs unit tests and a DB-less local mode. Everything
// the Prisma repo persists is held in plain maps/arrays here.

export class InMemoryRepository implements Repository {
  private plans = new Map<string, BillingPlan>();
  private userPlans = new Map<string, string>();
  private deployments = new Map<string, BilledDeployment>();
  private intervals: ServerBillingRecord[] = [];
  private wallets = new Map<string, CreditWallet>();
  private ledger: CreditLedgerEntry[] = [];
  private cycles: BillingCycleRecord[] = [];

  constructor(plans: BillingPlan[] = [DEFAULT_PLAN]) {
    for (const p of plans) this.plans.set(p.id, p);
  }

  /** Assign a user to a plan (test/setup helper; not part of the interface). */
  assignPlan(userId: string, planId: string): void {
    this.userPlans.set(userId, planId);
  }

  async getUserPlan(userId: string): Promise<BillingPlan> {
    const planId = this.userPlans.get(userId);
    return (planId && this.plans.get(planId)) || this.plans.get(DEFAULT_PLAN.id) || DEFAULT_PLAN;
  }

  async listPlans(): Promise<BillingPlan[]> {
    return [...this.plans.values()].map((p) => ({ ...p }));
  }

  async getPlan(id: string): Promise<BillingPlan | null> {
    const plan = this.plans.get(id);
    return plan ? { ...plan } : null;
  }

  async savePlan(plan: BillingPlan): Promise<BillingPlan> {
    this.plans.set(plan.id, { ...plan });
    return { ...plan };
  }

  async setUserPlan(userId: string, planId: string): Promise<void> {
    this.userPlans.set(userId, planId);
  }

  async saveDeployment(deployment: BilledDeployment): Promise<void> {
    this.deployments.set(deployment.deploymentId, { ...deployment });
  }

  async getDeployment(deploymentId: string): Promise<BilledDeployment | null> {
    const found = this.deployments.get(deploymentId);
    return found ? { ...found } : null;
  }

  async getOpenInterval(deploymentId: string): Promise<ServerBillingRecord | null> {
    return [...this.intervals].reverse().find((i) => i.deploymentId === deploymentId && i.stoppedAt === null) ?? null;
  }

  async getLastInterval(deploymentId: string): Promise<ServerBillingRecord | null> {
    return [...this.intervals].reverse().find((i) => i.deploymentId === deploymentId) ?? null;
  }

  async openInterval(input: OpenIntervalInput): Promise<ServerBillingRecord> {
    const record: ServerBillingRecord = {
      id: randomUUID(),
      userId: input.userId,
      deploymentId: input.deploymentId,
      planId: input.planId,
      limits: input.limits,
      startedAt: input.startedAt,
      stoppedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.intervals.push(record);
    return record;
  }

  async closeInterval(deploymentId: string, stoppedAt: string): Promise<ServerBillingRecord | null> {
    // Close the most recent still-open interval for this deployment.
    const open = [...this.intervals].reverse().find((i) => i.deploymentId === deploymentId && i.stoppedAt === null);
    if (!open) return null;
    open.stoppedAt = stoppedAt;
    return open;
  }

  async listIntervals(userId: string): Promise<ServerBillingRecord[]> {
    return this.intervals.filter((i) => i.userId === userId);
  }

  async getWallet(userId: string): Promise<CreditWallet> {
    let wallet = this.wallets.get(userId);
    if (!wallet) {
      wallet = { userId, balance: 0, currency: DEFAULT_PLAN.currency };
      this.wallets.set(userId, wallet);
    }
    return { ...wallet };
  }

  async setBalance(userId: string, balance: number): Promise<CreditWallet> {
    const wallet = await this.getWallet(userId);
    const updated = { ...wallet, balance };
    this.wallets.set(userId, updated);
    return { ...updated };
  }

  async createLedgerEntry(input: CreateLedgerInput): Promise<CreditLedgerEntry> {
    const entry: CreditLedgerEntry = { id: randomUUID(), createdAt: new Date().toISOString(), failureReason: null, ...input };
    this.ledger.push(entry);
    return { ...entry };
  }

  async getLedgerByReference(reference: string): Promise<CreditLedgerEntry | null> {
    const entry = this.ledger.find((e) => e.reference === reference);
    return entry ? { ...entry } : null;
  }

  async updateLedgerStatus(id: string, status: LedgerStatus): Promise<CreditLedgerEntry | null> {
    const entry = this.ledger.find((e) => e.id === id);
    if (!entry) return null;
    entry.status = status;
    return { ...entry };
  }

  async transitionLedgerStatus(id: string, from: LedgerStatus[], to: LedgerStatus, failureReason?: string): Promise<boolean> {
    const entry = this.ledger.find((e) => e.id === id);
    if (!entry || !from.includes(entry.status)) return false;
    entry.status = to;
    if (failureReason !== undefined) entry.failureReason = failureReason;
    return true;
  }

  async listPendingTopUps(createdBefore: string): Promise<CreditLedgerEntry[]> {
    return this.ledger.filter((e) => e.type === 'topup' && e.status === 'pending' && e.createdAt < createdBefore).map((e) => ({ ...e }));
  }

  async listLedger(userId: string): Promise<CreditLedgerEntry[]> {
    return this.ledger.filter((e) => e.userId === userId).map((e) => ({ ...e }));
  }

  async createCycle(input: CreateCycleInput): Promise<BillingCycleRecord> {
    const cycle: BillingCycleRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.cycles.push(cycle);
    return { ...cycle };
  }

  async listCycles(userId: string): Promise<BillingCycleRecord[]> {
    return this.cycles.filter((c) => c.userId === userId).map((c) => ({ ...c }));
  }

  async listBillableUserIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const i of this.intervals) ids.add(i.userId);
    for (const userId of this.wallets.keys()) ids.add(userId);
    for (const userId of this.userPlans.keys()) ids.add(userId);
    for (const d of this.deployments.values()) ids.add(d.userId);
    return [...ids];
  }
}
