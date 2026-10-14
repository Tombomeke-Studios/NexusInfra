import { describe, it, expect } from 'vitest';
import { limitChoiceFrom, withSizeLimits, capMbOf } from './limits';

// Resizing a server after creation (#381). The PATCH replaces resourceLimits
// whole, so what the form sends has to carry the fields it does not edit.

describe('limitChoiceFrom', () => {
  it('opens in the unit the server was created with', () => {
    expect(limitChoiceFrom({ ramMb: 4096, cpuCores: 2 })).toMatchObject({ ramUnit: 'mb', ramMb: 4096, cpuUnit: 'cores', cpuCores: 2 });
    expect(limitChoiceFrom({ ramPercent: 40, cpuPercent: 60 })).toMatchObject({ ramUnit: 'percent', ramPercent: 40, cpuUnit: 'percent', cpuPercent: 60 });
  });

  it('prefers the absolute amount when both were stored, as the API does', () => {
    expect(limitChoiceFrom({ ramMb: 3072, ramPercent: 50 })).toMatchObject({ ramUnit: 'mb', ramMb: 3072 });
  });

  it('shows an uncapped server as 0 MB rather than inventing a limit', () => {
    expect(limitChoiceFrom({})).toMatchObject({ ramUnit: 'mb', ramMb: 0, cpuUnit: 'cores', cpuCores: 0 });
    expect(limitChoiceFrom(undefined)).toMatchObject({ ramMb: 0, cpuCores: 0 });
  });
});

describe('withSizeLimits', () => {
  const existing = { ramPercent: 50, cpuPercent: 50, swapPercent: 10, ioPriority: 'high' as const, restartPolicy: 'always' as const, oomKill: false };

  it('keeps every limit it does not edit', () => {
    const next = withSizeLimits(existing, { ...limitChoiceFrom(existing), ramUnit: 'mb', ramMb: 6144 });
    expect(next).toMatchObject({ swapPercent: 10, ioPriority: 'high', restartPolicy: 'always', oomKill: false, cpuPercent: 50 });
  });

  it('sends only the chosen unit, so the old one cannot win', () => {
    const toMb = withSizeLimits(existing, { ...limitChoiceFrom(existing), ramUnit: 'mb', ramMb: 6144 });
    expect(toMb.ramMb).toBe(6144);
    expect(toMb).not.toHaveProperty('ramPercent');

    const toPercent = withSizeLimits({ ramMb: 2048, cpuCores: 1 }, { ...limitChoiceFrom({ ramMb: 2048, cpuCores: 1 }), ramUnit: 'percent', ramPercent: 25, cpuUnit: 'percent', cpuPercent: 30 });
    expect(toPercent).toEqual({ ramPercent: 25, cpuPercent: 30 });
  });

  it('removes the cap when the amount is 0', () => {
    const next = withSizeLimits({ ramMb: 2048, cpuCores: 2 }, { ...limitChoiceFrom({}), ramUnit: 'mb', ramMb: 0, cpuUnit: 'cores', cpuCores: 0 });
    expect(next).not.toHaveProperty('ramMb');
    expect(next).not.toHaveProperty('ramPercent');
    expect(next).not.toHaveProperty('cpuCores');
  });
});

describe('capMbOf', () => {
  it('reads an absolute cap without needing the node', () => {
    expect(capMbOf({ ...limitChoiceFrom({}), ramUnit: 'mb', ramMb: 3072 }, null)).toBe(3072);
  });

  it('turns a percentage into megabytes on the node the server is on', () => {
    expect(capMbOf({ ...limitChoiceFrom({}), ramUnit: 'percent', ramPercent: 25 }, 16384)).toBe(4096);
  });

  it('does not guess when the node has not reported its memory, or there is no cap', () => {
    expect(capMbOf({ ...limitChoiceFrom({}), ramUnit: 'percent', ramPercent: 25 }, null)).toBeNull();
    expect(capMbOf({ ...limitChoiceFrom({}), ramUnit: 'mb', ramMb: 0 }, 16384)).toBeNull();
  });
});
