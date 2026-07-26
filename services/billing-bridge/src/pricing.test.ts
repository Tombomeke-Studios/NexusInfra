import { describe, it, expect } from 'vitest';
import { billableHours, computeCharge, DEFAULT_PLAN, resourceFactor, roundCurrency, type BillingPlan } from './pricing.js';

const plan: BillingPlan = { ...DEFAULT_PLAN, pricePerHour: 0.1, freeHoursPerMonth: 10 };

describe('resourceFactor', () => {
  it('is 1.0 for a standard unit (50% cpu + 50% ram)', () => {
    expect(resourceFactor({ cpuPercent: 50, ramPercent: 50 })).toBe(1);
  });

  it('treats absent limits as a standard unit', () => {
    expect(resourceFactor({})).toBe(1);
    expect(resourceFactor(undefined)).toBe(1);
  });

  it('scales up for bigger servers', () => {
    expect(resourceFactor({ cpuPercent: 100, ramPercent: 100 })).toBe(2);
    expect(resourceFactor({ cpuPercent: 75, ramPercent: 75 })).toBe(1.5);
  });

  it('never drops below the floor', () => {
    expect(resourceFactor({ cpuPercent: 1, ramPercent: 1 })).toBe(0.25);
  });
});

describe('billableHours', () => {
  it('subtracts the free-hour grant, floored at zero', () => {
    expect(billableHours(5, plan)).toBe(0);
    expect(billableHours(10, plan)).toBe(0);
    expect(billableHours(30, plan)).toBe(20);
  });
});

describe('computeCharge', () => {
  it('is zero within the free tier', () => {
    expect(computeCharge({ totalHours: 8, plan })).toBe(0);
  });

  it('charges post-free hours × rate × factor', () => {
    // (30 - 10) billable × 0.1 × factor 1.0 = 2.00
    expect(computeCharge({ totalHours: 30, plan })).toBe(2);
    // same hours on a 2× server → 4.00
    expect(computeCharge({ totalHours: 30, plan, limits: { cpuPercent: 100, ramPercent: 100 } })).toBe(4);
  });

  it('rounds to cents', () => {
    expect(roundCurrency(2.005)).toBe(2.01);
    expect(computeCharge({ totalHours: 11, plan, limits: { cpuPercent: 33, ramPercent: 33 } })).toBe(roundCurrency(1 * 0.1 * resourceFactor({ cpuPercent: 33, ramPercent: 33 })));
  });
});
