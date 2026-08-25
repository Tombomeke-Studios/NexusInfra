import { roundCurrency } from './pricing.js';

// Pure credit-wallet math. The wallet holds a prepaid balance in NexusInfra;
// top-ups add to it (funded via FinVault) and usage charges draw it down. Money
// never sits in NexusInfra beyond this credit figure — see docs/billing.md.

/** Add credit (a confirmed top-up), rounded to cents. */
export function applyTopUp(balance: number, amount: number): number {
  return roundCurrency(balance + Math.max(0, amount));
}

/** Draw down credit for a usage charge; the balance may go negative (short). */
export function applyCharge(balance: number, amount: number): number {
  return roundCurrency(balance - Math.max(0, amount));
}

/** Whether the balance can cover a charge without going short. */
export function canCover(balance: number, amount: number): boolean {
  return balance >= amount;
}
