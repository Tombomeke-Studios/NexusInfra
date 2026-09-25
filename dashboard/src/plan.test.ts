import { describe, it, expect } from 'vitest';
import { chargingSentence, countOf, formatMb, ramVerdict } from './plan';
import type { Entitlements } from './api';

const plan = (maxRamMb: number | null): Entitlements => ({
  planId: 'standard',
  planName: 'Standard',
  maxServers: 5,
  maxDatabases: 5,
  maxRamMb,
  maxBackupsPerServer: 10,
  charging: { basis: 'runtime-hours', pricePerHour: 0.02, currency: 'EUR', freeHoursPerMonth: 100, sizeFactor: { standardCpuPercent: 50, standardRamPercent: 50, minimum: 0.25 } },
});
const used = (ramMb: number) => ({ servers: 1, databases: 0, ramMb, uncappedServers: 0 });

describe('ramVerdict — the server rule, mirrored (#297)', () => {
  it('fits, and says where it leaves you', () => {
    expect(ramVerdict(plan(8192), used(2048), 2048)).toEqual({ kind: 'fits', afterMb: 4096, maxMb: 8192 });
  });
  it('is over when it needs more than is left', () => {
    expect(ramVerdict(plan(4096), used(3072), 2048)).toEqual({ kind: 'over', neededMb: 2048, leftMb: 1024, maxMb: 4096 });
  });
  it('refuses no cap under a ceiling', () => {
    expect(ramVerdict(plan(4096), used(0), 0)).toEqual({ kind: 'uncapped', maxMb: 4096 });
  });
  it('has nothing to say without a ceiling, or without a size', () => {
    expect(ramVerdict(plan(null), used(0), 99999).kind).toBe('unlimited');
    expect(ramVerdict(plan(4096), used(0), null).kind).toBe('unknown');
  });
});

describe('chargingSentence', () => {
  it('states the model a bill can be predicted from', () => {
    const s = chargingSentence(plan(null).charging);
    expect(s).toContain('€0.02 for each hour a server runs');
    expect(s).toContain('50% CPU and 50% RAM counts once');
    expect(s).toContain('first 100 hours each month are free');
    expect(s).toContain('Creating a server costs nothing, and neither does a stopped one.');
  });
  it('leaves out free hours a plan does not have', () => {
    expect(chargingSentence({ ...plan(null).charging, freeHoursPerMonth: 0 })).not.toContain('free');
  });
});

describe('formatting', () => {
  it('formats memory the way people say it', () => {
    expect(formatMb(512)).toBe('512 MB');
    expect(formatMb(2048)).toBe('2 GB');
    expect(formatMb(1536)).toBe('1.5 GB');
  });
  it('counts against a ceiling, or alone', () => {
    expect(countOf(2, 5)).toBe('2 of 5');
    expect(countOf(2, null)).toBe('2');
  });
});
