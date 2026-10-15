import { describe, it, expect } from 'vitest';
import { DEFAULT_PLAN, type BillingPlan } from './pricing.js';
import { parsePlanInput, planIdFrom, retireProblem, switchProblem } from './plans.js';

const VALID = { name: 'Pro', pricePerHour: 0.05, freeHoursPerMonth: 0, maxServers: 10, maxDatabases: 10, maxRamMb: 16384, maxBackupsPerServer: 20 };
const PRO: BillingPlan = { ...DEFAULT_PLAN, ...VALID, id: 'pro', active: true };

describe('parsePlanInput (#369)', () => {
  it('accepts a complete plan, offered by default', () => {
    expect(parsePlanInput({ ...VALID, name: '  Pro ' })).toEqual({ ok: true, plan: { ...VALID, active: true } });
  });

  it('reads an empty ceiling as no ceiling', () => {
    const parsed = parsePlanInput({ ...VALID, maxRamMb: null, maxBackupsPerServer: '' });
    expect(parsed).toMatchObject({ ok: true, plan: { maxRamMb: null, maxBackupsPerServer: null } });
  });

  it('says which field is wrong', () => {
    expect(parsePlanInput({ ...VALID, name: ' ' })).toMatchObject({ ok: false, error: expect.stringContaining('name') });
    expect(parsePlanInput({ ...VALID, pricePerHour: -1 })).toMatchObject({ ok: false, error: expect.stringContaining('price') });
    expect(parsePlanInput({ ...VALID, pricePerHour: '0.05' })).toMatchObject({ ok: false, error: expect.stringContaining('price') });
    expect(parsePlanInput({ ...VALID, freeHoursPerMonth: -5 })).toMatchObject({ ok: false, error: expect.stringContaining('free hours') });
    expect(parsePlanInput({ ...VALID, maxServers: 2.5 })).toMatchObject({ ok: false, error: expect.stringContaining('server limit') });
    expect(parsePlanInput({ ...VALID, maxRamMb: 64 })).toMatchObject({ ok: false, error: expect.stringContaining('memory') });
    expect(parsePlanInput({ ...VALID, maxBackupsPerServer: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('backups') });
  });

  it('lets an edit send only what changed', () => {
    expect(parsePlanInput({ pricePerHour: 0.08 }, PRO)).toMatchObject({ ok: true, plan: { name: 'Pro', pricePerHour: 0.08, maxServers: 10 } });
    // …including clearing a ceiling, which is not the same as leaving it out.
    expect(parsePlanInput({ maxRamMb: null }, PRO)).toMatchObject({ ok: true, plan: { maxRamMb: null } });
    expect(parsePlanInput({ active: false }, PRO)).toMatchObject({ ok: true, plan: { active: false } });
  });
});

describe('planIdFrom', () => {
  it('makes an id out of a name', () => {
    expect(planIdFrom('Pro Plus (2026)')).toBe('pro-plus-2026');
    expect(planIdFrom('  Économie ')).toBe('e-conomie');
    expect(planIdFrom('!!!')).toBe('');
  });
});

describe('who may be on which plan', () => {
  it('never retires the default plan', () => {
    expect(retireProblem({ ...DEFAULT_PLAN })).toMatch(/default plan/);
    expect(retireProblem(PRO)).toBeNull();
  });

  it('lets an account move to a plan that is offered', () => {
    expect(switchProblem(PRO, 'standard')).toBeNull();
    expect(switchProblem(null, 'standard')).toBe('no such plan');
  });

  it('keeps accounts on a retired plan, and lets nobody new choose it', () => {
    const retired = { ...PRO, active: false };
    expect(switchProblem(retired, 'standard')).toMatch(/no longer offered/);
    expect(switchProblem(retired, 'pro')).toBeNull();
  });
});
