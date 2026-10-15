import type { BillingPlanOption } from './api';

// Pure helpers for plans and the provider's Customers page (#369): the form's
// text fields in, a request body out; a plan in, the sentence that describes it.
// Hosted only — nothing in a community build imports this.

/** The plan form as typed. Memory is entered in GB; empty means no ceiling. */
export interface PlanForm {
  name: string;
  pricePerHour: string;
  freeHoursPerMonth: string;
  maxServers: string;
  maxDatabases: string;
  maxRamGb: string;
  maxBackupsPerServer: string;
}

export const EMPTY_PLAN_FORM: PlanForm = { name: '', pricePerHour: '', freeHoursPerMonth: '0', maxServers: '5', maxDatabases: '5', maxRamGb: '', maxBackupsPerServer: '' };

export function planToForm(plan: BillingPlanOption): PlanForm {
  return {
    name: plan.name,
    pricePerHour: String(plan.pricePerHour),
    freeHoursPerMonth: String(plan.freeHoursPerMonth),
    maxServers: String(plan.maxServers),
    maxDatabases: String(plan.maxDatabases),
    maxRamGb: plan.maxRamMb == null ? '' : String(plan.maxRamMb / 1024),
    maxBackupsPerServer: plan.maxBackupsPerServer == null ? '' : String(plan.maxBackupsPerServer),
  };
}

export type PlanBody = Pick<BillingPlanOption, 'name' | 'pricePerHour' | 'freeHoursPerMonth' | 'maxServers' | 'maxDatabases' | 'maxRamMb' | 'maxBackupsPerServer'>;

/** A decimal as people type it: a comma is a decimal point in half of Europe. */
const number = (text: string): number => (text.trim() === '' ? NaN : Number(text.trim().replace(',', '.')));

/**
 * The request body for a plan form, or the first thing wrong with it. The
 * server validates again; this is so a typo is caught before the round trip and
 * said in the form's own words.
 */
export function formToPlan(form: PlanForm): { ok: true; body: PlanBody } | { ok: false; error: string } {
  if (!form.name.trim()) return { ok: false, error: 'Give the plan a name.' };
  const pricePerHour = number(form.pricePerHour);
  if (!(pricePerHour >= 0)) return { ok: false, error: 'The hourly price must be a number, zero or more.' };
  const freeHoursPerMonth = form.freeHoursPerMonth.trim() === '' ? 0 : number(form.freeHoursPerMonth);
  if (!(freeHoursPerMonth >= 0)) return { ok: false, error: 'Free hours must be a number, zero or more.' };
  const maxServers = number(form.maxServers);
  if (!Number.isInteger(maxServers) || maxServers < 0) return { ok: false, error: 'The server limit must be a whole number.' };
  const maxDatabases = number(form.maxDatabases);
  if (!Number.isInteger(maxDatabases) || maxDatabases < 0) return { ok: false, error: 'The database limit must be a whole number.' };

  let maxRamMb: number | null = null;
  if (form.maxRamGb.trim() !== '') {
    const gb = number(form.maxRamGb);
    if (!(gb > 0)) return { ok: false, error: 'The memory ceiling must be a number of GB, or empty for no ceiling.' };
    maxRamMb = Math.round(gb * 1024);
  }
  let maxBackupsPerServer: number | null = null;
  if (form.maxBackupsPerServer.trim() !== '') {
    maxBackupsPerServer = number(form.maxBackupsPerServer);
    if (!Number.isInteger(maxBackupsPerServer) || maxBackupsPerServer < 1) return { ok: false, error: 'Backups per server must be a whole number of at least 1, or empty for no ceiling.' };
  }
  return { ok: true, body: { name: form.name.trim(), pricePerHour, freeHoursPerMonth, maxServers, maxDatabases, maxRamMb, maxBackupsPerServer } };
}

/** Money as the Billing page writes it. */
export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** An hourly rate keeps the digits a currency format would round away: €0.02 an hour is not €0.00. */
export function hourly(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

const gb = (mb: number) => `${Number((mb / 1024).toFixed(1))} GB`;

/** What a plan allows, as the short list shown on its card. */
export function planLimits(plan: Pick<BillingPlanOption, 'maxServers' | 'maxDatabases' | 'maxRamMb' | 'maxBackupsPerServer' | 'freeHoursPerMonth'>): string[] {
  const lines = [`${plan.maxServers} server${plan.maxServers === 1 ? '' : 's'}`, `${plan.maxDatabases} database${plan.maxDatabases === 1 ? '' : 's'}`];
  lines.push(plan.maxRamMb == null ? 'No memory ceiling' : `${gb(plan.maxRamMb)} memory across your servers`);
  if (plan.maxBackupsPerServer != null) lines.push(`${plan.maxBackupsPerServer} backup${plan.maxBackupsPerServer === 1 ? '' : 's'} kept per server`);
  lines.push(plan.freeHoursPerMonth > 0 ? `First ${plan.freeHoursPerMonth} hours each month free` : 'No free hours');
  return lines;
}

/** A credit adjustment as typed, or what is wrong with it. Negative removes credit. */
export function parseAdjustment(amountText: string, reason: string): { ok: true; amount: number; reason: string } | { ok: false; error: string } {
  const amount = number(amountText);
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, error: 'Enter an amount — negative to remove credit.' };
  if (!reason.trim()) return { ok: false, error: 'Say why. The customer sees the reason in their payment history.' };
  return { ok: true, amount, reason: reason.trim() };
}
