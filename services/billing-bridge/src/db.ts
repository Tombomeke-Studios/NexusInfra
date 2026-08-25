import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_PLAN, type BillingPlan } from './pricing.js';
import type {
  BillingCycleRecord,
  CreateCycleInput,
  CreateLedgerInput,
  CreditLedgerEntry,
  CreditWallet,
  CycleStatus,
  LedgerStatus,
  LedgerType,
  OpenIntervalInput,
  Repository,
  ServerBillingRecord,
} from './types.js';
import type { ResourceLimits } from 'shared';

// Prisma-backed Repository (SQLite). Mapping helpers convert Prisma rows (Date
// objects, serialized JSON) to the plain domain records the service works with.

let prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

function parseLimits(value: string): ResourceLimits {
  try {
    const parsed = JSON.parse(value) as ResourceLimits;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

type PrismaPlan = Awaited<ReturnType<PrismaClient['billingPlan']['findFirstOrThrow']>>;
type PrismaInterval = Awaited<ReturnType<PrismaClient['serverBilling']['findFirstOrThrow']>>;
type PrismaLedger = Awaited<ReturnType<PrismaClient['creditLedger']['findFirstOrThrow']>>;
type PrismaCycle = Awaited<ReturnType<PrismaClient['billingCycle']['findFirstOrThrow']>>;

function toPlan(p: PrismaPlan): BillingPlan {
  return {
    id: p.id,
    name: p.name,
    pricePerHour: p.pricePerHour,
    currency: p.currency,
    freeHoursPerMonth: p.freeHoursPerMonth,
    maxServers: p.maxServers,
    maxDatabases: p.maxDatabases,
  };
}

function toInterval(i: PrismaInterval): ServerBillingRecord {
  return {
    id: i.id,
    userId: i.userId,
    deploymentId: i.deploymentId,
    planId: i.planId,
    limits: parseLimits(i.limits),
    startedAt: i.startedAt.toISOString(),
    stoppedAt: i.stoppedAt ? i.stoppedAt.toISOString() : null,
    createdAt: i.createdAt.toISOString(),
  };
}

function toLedger(e: PrismaLedger): CreditLedgerEntry {
  return {
    id: e.id,
    userId: e.userId,
    type: e.type as LedgerType,
    amount: e.amount,
    currency: e.currency,
    reference: e.reference,
    status: e.status as LedgerStatus,
    description: e.description,
    createdAt: e.createdAt.toISOString(),
  };
}

function toCycle(c: PrismaCycle): BillingCycleRecord {
  return {
    id: c.id,
    userId: c.userId,
    periodStart: c.periodStart.toISOString(),
    periodEnd: c.periodEnd.toISOString(),
    totalCost: c.totalCost,
    currency: c.currency,
    status: c.status as CycleStatus,
    createdAt: c.createdAt.toISOString(),
  };
}

export class PrismaRepository implements Repository {
  constructor(private readonly client: PrismaClient = getPrisma()) {}

  /** Seed the default plan if the plans table is empty (idempotent). */
  async ensureDefaultPlan(): Promise<void> {
    await this.client.billingPlan.upsert({
      where: { id: DEFAULT_PLAN.id },
      create: { ...DEFAULT_PLAN },
      update: {},
    });
  }

  async getUserPlan(userId: string): Promise<BillingPlan> {
    const assignment = await this.client.userPlan.findUnique({ where: { userId } });
    const planId = assignment?.planId ?? DEFAULT_PLAN.id;
    const plan = await this.client.billingPlan.findUnique({ where: { id: planId } });
    return plan ? toPlan(plan) : DEFAULT_PLAN;
  }

  async openInterval(input: OpenIntervalInput): Promise<ServerBillingRecord> {
    const row = await this.client.serverBilling.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        deploymentId: input.deploymentId,
        planId: input.planId,
        limits: JSON.stringify(input.limits ?? {}),
        startedAt: new Date(input.startedAt),
      },
    });
    return toInterval(row);
  }

  async closeInterval(deploymentId: string, stoppedAt: string): Promise<ServerBillingRecord | null> {
    const open = await this.client.serverBilling.findFirst({
      where: { deploymentId, stoppedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (!open) return null;
    const row = await this.client.serverBilling.update({ where: { id: open.id }, data: { stoppedAt: new Date(stoppedAt) } });
    return toInterval(row);
  }

  async listIntervals(userId: string): Promise<ServerBillingRecord[]> {
    const rows = await this.client.serverBilling.findMany({ where: { userId }, orderBy: { startedAt: 'asc' } });
    return rows.map(toInterval);
  }

  async getWallet(userId: string): Promise<CreditWallet> {
    const wallet = await this.client.creditWallet.upsert({
      where: { userId },
      create: { userId, balance: 0, currency: DEFAULT_PLAN.currency },
      update: {},
    });
    return { userId: wallet.userId, balance: wallet.balance, currency: wallet.currency };
  }

  async setBalance(userId: string, balance: number): Promise<CreditWallet> {
    const wallet = await this.client.creditWallet.upsert({
      where: { userId },
      create: { userId, balance, currency: DEFAULT_PLAN.currency },
      update: { balance },
    });
    return { userId: wallet.userId, balance: wallet.balance, currency: wallet.currency };
  }

  async createLedgerEntry(input: CreateLedgerInput): Promise<CreditLedgerEntry> {
    const row = await this.client.creditLedger.create({ data: { id: randomUUID(), ...input } });
    return toLedger(row);
  }

  async getLedgerByReference(reference: string): Promise<CreditLedgerEntry | null> {
    const row = await this.client.creditLedger.findUnique({ where: { reference } });
    return row ? toLedger(row) : null;
  }

  async updateLedgerStatus(id: string, status: LedgerStatus): Promise<CreditLedgerEntry | null> {
    const exists = await this.client.creditLedger.findUnique({ where: { id } });
    if (!exists) return null;
    const row = await this.client.creditLedger.update({ where: { id }, data: { status } });
    return toLedger(row);
  }

  async listLedger(userId: string): Promise<CreditLedgerEntry[]> {
    const rows = await this.client.creditLedger.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map(toLedger);
  }

  async createCycle(input: CreateCycleInput): Promise<BillingCycleRecord> {
    const row = await this.client.billingCycle.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        totalCost: input.totalCost,
        currency: input.currency,
        status: input.status,
      },
    });
    return toCycle(row);
  }

  async listCycles(userId: string): Promise<BillingCycleRecord[]> {
    const rows = await this.client.billingCycle.findMany({ where: { userId }, orderBy: { periodStart: 'desc' } });
    return rows.map(toCycle);
  }

  async listBillableUserIds(): Promise<string[]> {
    const [intervals, wallets] = await Promise.all([
      this.client.serverBilling.findMany({ distinct: ['userId'], select: { userId: true } }),
      this.client.creditWallet.findMany({ select: { userId: true } }),
    ]);
    const ids = new Set<string>();
    for (const i of intervals) ids.add(i.userId);
    for (const w of wallets) ids.add(w.userId);
    return [...ids];
  }
}
