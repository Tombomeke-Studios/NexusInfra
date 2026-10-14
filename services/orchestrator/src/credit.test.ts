import { describe, it, expect } from 'vitest';
import { creditLowSummary, creditProblem, runwayText, type Standing } from './credit.js';

const standing = (over: Partial<Standing> = {}): Standing => ({ balance: 0, accrued: 0, available: 0, freeHoursLeft: 0, canRun: false, currency: 'EUR', hoursLeft: null, runsLow: false, ...over });

describe('creditProblem (#365)', () => {
  it('has nothing to say where no rule applies', () => {
    expect(creditProblem(null)).toBeNull();
    expect(creditProblem(standing({ balance: 5, available: 5, canRun: true }))).toBeNull();
  });

  it('tells an account with nothing left where to get more', () => {
    expect(creditProblem(standing())).toMatch(/no credit left.*Billing page/);
  });

  it('says how much an account owes', () => {
    expect(creditProblem(standing({ balance: 1, accrued: 3.5, available: -2.5 }))).toContain('owes €2.50');
  });
});

describe('runway (#379)', () => {
  it('says how long in words a person reads at a glance', () => {
    expect(runwayText(0.4)).toBe('less than an hour');
    expect(runwayText(1)).toBe('about 1 hour');
    expect(runwayText(20.6)).toBe('about 21 hours');
    expect(runwayText(47)).toBe('about 47 hours');
    expect(runwayText(72)).toBe('about 3 days');
  });

  it('tells the account how long its credit lasts and what to do about it', () => {
    expect(creditLowSummary({ hoursLeft: 20, available: 4, currency: 'EUR' })).toBe(
      'Your credit (€4.00) runs out in about 20 hours at the rate your servers are using it — top up on the Billing page, or your servers will be stopped'
    );
  });
});
