import { describe, it, expect } from 'vitest';
import { expiredBackups, parseRetention } from './retention.js';
import type { ServerBackupRecord } from './types.js';

const now = new Date('2026-09-25T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
const backup = (id: string, createdAt: string): ServerBackupRecord => ({
  id, deploymentId: 'd', name: id, path: '/data', ref: `bk_${id}`, sizeBytes: 1, status: 'ready', createdAt, offsite: null,
});

describe('expiredBackups (#232)', () => {
  const five = [backup('a', daysAgo(0)), backup('b', daysAgo(1)), backup('c', daysAgo(2)), backup('d', daysAgo(10)), backup('e', daysAgo(40))];

  it('keeps everything without a policy — what every server did before', () => {
    expect(expiredBackups(five, {}, now)).toEqual([]);
  });

  it('keeps the newest N', () => {
    expect(expiredBackups(five, { keepLast: 3 }, now).map((b) => b.id)).toEqual(['d', 'e']);
  });

  it('keeps what is younger than N days', () => {
    expect(expiredBackups(five, { keepDays: 7 }, now).map((b) => b.id)).toEqual(['d', 'e']);
  });

  it('treats both as limits: a backup that breaks either one goes', () => {
    expect(expiredBackups(five, { keepLast: 4, keepDays: 30 }, now).map((b) => b.id)).toEqual(['e']);
    expect(expiredBackups(five, { keepLast: 2, keepDays: 30 }, now).map((b) => b.id)).toEqual(['c', 'd', 'e']);
  });

  it('never deletes the newest backup, however old — the last copy is not the one to lose', () => {
    const old = [backup('only', daysAgo(400))];
    expect(expiredBackups(old, { keepDays: 7 }, now)).toEqual([]);
    expect(expiredBackups([backup('x', daysAgo(50)), backup('y', daysAgo(60))], { keepDays: 7 }, now).map((b) => b.id)).toEqual(['y']);
  });

  it('decides by age, whatever order the backups arrive in', () => {
    const shuffled = [five[3], five[0], five[4], five[2], five[1]];
    expect(expiredBackups(shuffled, { keepLast: 3 }, now).map((b) => b.id).sort()).toEqual(['d', 'e']);
  });
});

describe('parseRetention', () => {
  it('accepts whole numbers in range, and null to clear', () => {
    expect(parseRetention({ keepLast: 7, keepDays: 30 })).toEqual({ ok: true, policy: { keepLast: 7, keepDays: 30 } });
    expect(parseRetention({ keepLast: null })).toEqual({ ok: true, policy: {} });
    expect(parseRetention({})).toEqual({ ok: true, policy: {} });
  });

  it('refuses anything that would read as "delete everything" or nonsense', () => {
    for (const bad of [{ keepLast: 0 }, { keepLast: -1 }, { keepLast: 1.5 }, { keepDays: 0 }, { keepDays: 'x' }, { keepLast: 100000 }, null, []]) {
      expect(parseRetention(bad).ok).toBe(false);
    }
  });
});
