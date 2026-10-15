import { describe, it, expect } from 'vitest';
import { EMPTY_PLAN_FORM, formToPlan, hourly, parseAdjustment, planLimits, planToForm } from './billingAdmin';
import type { BillingPlanOption } from './api';

const PLAN: BillingPlanOption = { id: 'pro', name: 'Pro', pricePerHour: 0.05, currency: 'EUR', freeHoursPerMonth: 0, maxServers: 10, maxDatabases: 1, maxRamMb: 16384, maxBackupsPerServer: null, active: true };

describe('the plan form (#369)', () => {
  it('turns what was typed into a plan, memory in GB', () => {
    const parsed = formToPlan({ name: ' Pro ', pricePerHour: '0,05', freeHoursPerMonth: '', maxServers: '10', maxDatabases: '1', maxRamGb: '16', maxBackupsPerServer: '' });
    expect(parsed).toEqual({ ok: true, body: { name: 'Pro', pricePerHour: 0.05, freeHoursPerMonth: 0, maxServers: 10, maxDatabases: 1, maxRamMb: 16384, maxBackupsPerServer: null } });
  });

  it('reads an empty ceiling as none', () => {
    const parsed = formToPlan({ ...EMPTY_PLAN_FORM, name: 'Free', pricePerHour: '0' });
    expect(parsed).toMatchObject({ ok: true, body: { maxRamMb: null, maxBackupsPerServer: null } });
  });

  it('names the field that is wrong', () => {
    const form = planToForm(PLAN);
    expect(formToPlan({ ...form, name: '' })).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(formToPlan({ ...form, pricePerHour: 'cheap' })).toMatchObject({ ok: false, error: expect.stringContaining('price') });
    expect(formToPlan({ ...form, pricePerHour: '' })).toMatchObject({ ok: false, error: expect.stringContaining('price') });
    expect(formToPlan({ ...form, maxServers: '2.5' })).toMatchObject({ ok: false, error: expect.stringContaining('server limit') });
    expect(formToPlan({ ...form, maxRamGb: '0' })).toMatchObject({ ok: false, error: expect.stringContaining('memory') });
    expect(formToPlan({ ...form, maxBackupsPerServer: '0' })).toMatchObject({ ok: false, error: expect.stringContaining('Backups') });
  });

  it('round-trips a plan through the form unchanged', () => {
    const body = { name: PLAN.name, pricePerHour: PLAN.pricePerHour, freeHoursPerMonth: PLAN.freeHoursPerMonth, maxServers: PLAN.maxServers, maxDatabases: PLAN.maxDatabases, maxRamMb: PLAN.maxRamMb, maxBackupsPerServer: PLAN.maxBackupsPerServer };
    expect(formToPlan(planToForm(PLAN))).toEqual({ ok: true, body });
  });
});

describe('describing a plan', () => {
  it('lists what it allows', () => {
    expect(planLimits(PLAN)).toEqual(['10 servers', '1 database', '16 GB memory across your servers', 'No free hours']);
    expect(planLimits({ ...PLAN, maxServers: 1, maxRamMb: null, maxBackupsPerServer: 5, freeHoursPerMonth: 100 })).toEqual([
      '1 server',
      '1 database',
      'No memory ceiling',
      '5 backups kept per server',
      'First 100 hours each month free',
    ]);
  });

  // Two decimals would print a €0.02 rate as it is and a €0.005 one as €0.01.
  it('keeps the digits of a small hourly rate', () => {
    expect(hourly(0.005, 'EUR')).toMatch(/0[.,]005/);
    expect(hourly(0.02, 'EUR')).toMatch(/0[.,]02/);
  });
});

describe('a credit adjustment', () => {
  it('needs an amount and a reason', () => {
    expect(parseAdjustment('25', ' refund ')).toEqual({ ok: true, amount: 25, reason: 'refund' });
    expect(parseAdjustment('-5,50', 'charged back')).toEqual({ ok: true, amount: -5.5, reason: 'charged back' });
    expect(parseAdjustment('0', 'x')).toMatchObject({ ok: false });
    expect(parseAdjustment('', 'x')).toMatchObject({ ok: false });
    expect(parseAdjustment('10', '  ')).toMatchObject({ ok: false, error: expect.stringContaining('why') });
  });
});
