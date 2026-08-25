import { describe, it, expect } from 'vitest';
import { quotaLimit, withinQuota } from './quotas.js';
import { DEFAULT_PLAN } from './pricing.js';

const plan = { ...DEFAULT_PLAN, maxServers: 3, maxDatabases: 2 };

describe('quotas', () => {
  it('reads the per-resource limit', () => {
    expect(quotaLimit(plan, 'servers')).toBe(3);
    expect(quotaLimit(plan, 'databases')).toBe(2);
  });

  it('allows creation below the cap', () => {
    expect(withinQuota(plan, 'servers', 0)).toBe(true);
    expect(withinQuota(plan, 'servers', 2)).toBe(true);
  });

  it('blocks creation at or above the cap', () => {
    expect(withinQuota(plan, 'servers', 3)).toBe(false);
    expect(withinQuota(plan, 'databases', 2)).toBe(false);
  });
});
