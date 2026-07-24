import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from './repository.js';
import { selectDue, tickSchedules, type ScheduleActions } from './scheduler.js';
import type { ServerScheduleRecord } from './types.js';

const base: ServerScheduleRecord = {
  id: 's1',
  deploymentId: 'dep-1',
  name: 'Nightly',
  cron: '0 4 * * *',
  action: 'backup',
  enabled: true,
  lastRunAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
};
const at4am = new Date('2026-07-24T04:00:00Z');

describe('selectDue', () => {
  it('includes an enabled, matching, not-yet-run-this-minute schedule', () => {
    expect(selectDue([base], at4am).map((s) => s.id)).toEqual(['s1']);
  });

  it('excludes disabled schedules', () => {
    expect(selectDue([{ ...base, enabled: false }], at4am)).toEqual([]);
  });

  it('excludes a schedule already run this minute', () => {
    expect(selectDue([{ ...base, lastRunAt: '2026-07-24T04:00:30.000Z' }], at4am)).toEqual([]);
    // A run in a previous minute does not exclude it.
    expect(selectDue([{ ...base, lastRunAt: '2026-07-24T03:00:00.000Z' }], at4am).map((s) => s.id)).toEqual(['s1']);
  });
});

describe('tickSchedules', () => {
  let repo: InMemoryRepository;
  let calls: string[];
  const actions: ScheduleActions = {
    restart: async (id) => void calls.push(`restart:${id}`),
    backup: async (id) => void calls.push(`backup:${id}`),
  };

  beforeEach(() => {
    repo = new InMemoryRepository();
    calls = [];
  });

  it('runs a due schedule and stamps lastRunAt so it will not re-run the same minute', async () => {
    const s = await repo.createSchedule({ deploymentId: 'dep-1', name: 'Nightly', cron: '0 4 * * *', action: 'backup' });

    const ran = await tickSchedules(repo, at4am, actions);
    expect(ran.map((r) => r.id)).toEqual([s.id]);
    expect(calls).toEqual(['backup:dep-1']);
    expect((await repo.getSchedule(s.id))?.lastRunAt).toBe(at4am.toISOString());

    // A second tick in the same minute is a no-op.
    calls = [];
    expect(await tickSchedules(repo, at4am, actions)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('keeps running other schedules when one action throws', async () => {
    await repo.createSchedule({ deploymentId: 'boom', name: 'Restart', cron: '0 4 * * *', action: 'restart' });
    await repo.createSchedule({ deploymentId: 'ok', name: 'Backup', cron: '0 4 * * *', action: 'backup' });
    const flaky: ScheduleActions = {
      restart: async () => { throw new Error('nope'); },
      backup: async (id) => void calls.push(`backup:${id}`),
    };
    const ran = await tickSchedules(repo, at4am, flaky);
    expect(ran).toHaveLength(2);
    expect(calls).toEqual(['backup:ok']); // the backup still ran
  });
});
