import type { ResourceLimits } from 'shared';
import type { BillingPlan } from './pricing.js';

// Domain records + the Repository interface for the Billing Bridge. Mirrors the
// Orchestrator's split: logic depends on Repository, not on Prisma, so it runs
// against an in-memory store in tests and SQLite in production.

export type LedgerType = 'topup' | 'charge';
/**
 * `expired` is a top-up FinVault has not confirmed in time (#298) — shown as
 * unconfirmed rather than pending forever. It is not final: a confirmation that
 * arrives later means the money did move, so it is still credited.
 */
export type LedgerStatus = 'pending' | 'confirmed' | 'failed' | 'expired';
export type CycleStatus = 'open' | 'paid' | 'overdue';

/** One runtime interval for a deployment (server_billing): open until stopped. */
export interface ServerBillingRecord {
  id: string;
  userId: string;
  deploymentId: string;
  planId: string;
  limits: ResourceLimits;
  startedAt: string;
  stoppedAt: string | null;
  createdAt: string;
}

/** A user's prepaid credit balance (credit_wallet). */
export interface CreditWallet {
  userId: string;
  balance: number;
  currency: string;
}

/** An append-only credit movement (credit_ledger): a top-up or a usage charge. */
export interface CreditLedgerEntry {
  id: string;
  userId: string;
  type: LedgerType;
  amount: number;
  currency: string;
  /** Links a top-up to its payment.* events; unique per top-up. */
  reference: string;
  status: LedgerStatus;
  description: string;
  createdAt: string;
}

/** A monthly billing cycle for a user (billing_cycles). Driven in #147. */
export interface BillingCycleRecord {
  id: string;
  userId: string;
  periodStart: string;
  periodEnd: string;
  totalCost: number;
  currency: string;
  status: CycleStatus;
  createdAt: string;
}

export interface OpenIntervalInput {
  userId: string;
  deploymentId: string;
  planId: string;
  limits: ResourceLimits;
  startedAt: string;
}

export interface CreateLedgerInput {
  userId: string;
  type: LedgerType;
  amount: number;
  currency: string;
  reference: string;
  status: LedgerStatus;
  description: string;
}

export interface CreateCycleInput {
  userId: string;
  periodStart: string;
  periodEnd: string;
  totalCost: number;
  currency: string;
  status: CycleStatus;
}

export interface Repository {
  // Plans
  getUserPlan(userId: string): Promise<BillingPlan>;

  // Runtime intervals (server_billing)
  openInterval(input: OpenIntervalInput): Promise<ServerBillingRecord>;
  closeInterval(deploymentId: string, stoppedAt: string): Promise<ServerBillingRecord | null>;
  listIntervals(userId: string): Promise<ServerBillingRecord[]>;

  // Wallet
  getWallet(userId: string): Promise<CreditWallet>;
  setBalance(userId: string, balance: number): Promise<CreditWallet>;

  // Ledger
  createLedgerEntry(input: CreateLedgerInput): Promise<CreditLedgerEntry>;
  getLedgerByReference(reference: string): Promise<CreditLedgerEntry | null>;
  updateLedgerStatus(id: string, status: LedgerStatus): Promise<CreditLedgerEntry | null>;
  /**
   * Move an entry to `to` only if it is currently in one of `from` — true when
   * this call made the change. The guard against crediting one top-up twice when
   * its confirmation is delivered twice at once (#298).
   */
  transitionLedgerStatus(id: string, from: LedgerStatus[], to: LedgerStatus): Promise<boolean>;
  /** Top-ups still pending that were requested before `createdBefore`. */
  listPendingTopUps(createdBefore: string): Promise<CreditLedgerEntry[]>;
  listLedger(userId: string): Promise<CreditLedgerEntry[]>;

  // Cycles
  createCycle(input: CreateCycleInput): Promise<BillingCycleRecord>;
  listCycles(userId: string): Promise<BillingCycleRecord[]>;

  /** Distinct users with any billing activity (intervals or a wallet) — the set the cycle runner bills. */
  listBillableUserIds(): Promise<string[]>;
}
