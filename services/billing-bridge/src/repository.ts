import { randomUUID } from 'crypto';
import { DEFAULT_PLAN, type BillingPlan } from './pricing.js';
import type {
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
    const entry: CreditLedgerEntry = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
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
    return [...ids];
  }
}
