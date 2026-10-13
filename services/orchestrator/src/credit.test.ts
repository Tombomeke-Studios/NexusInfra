import { describe, it, expect } from 'vitest';
import { creditProblem, type Standing } from './credit.js';

const standing = (over: Partial<Standing> = {}): Standing => ({ balance: 0, accrued: 0, available: 0, freeHoursLeft: 0, canRun: false, currency: 'EUR', ...over });

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
