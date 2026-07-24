import { cronMatches } from './cron.js';
import type { Repository, ServerScheduleRecord } from './types.js';

// The recurring-task runner (#111). `selectDue` is pure so scheduling decisions are
// unit-tested; `tickSchedules` runs the due actions and stamps lastRunAt;
// `startScheduler` polls once a minute. Actions are injected so the loop stays
// decoupled from how a restart/backup is actually performed.

export interface ScheduleActions {
  restart(deploymentId: string): Promise<void>;
  backup(deploymentId: string): Promise<void>;
}

/** Enabled schedules whose cron fires at `now` and that haven't already run this minute. */
export function selectDue(schedules: ServerScheduleRecord[], now: Date): ServerScheduleRecord[] {
  const minute = now.toISOString().slice(0, 16); // yyyy-mm-ddThh:mm
  return schedules.filter(
    (s) => s.enabled && cronMatches(s.cron, now) && (!s.lastRunAt || s.lastRunAt.slice(0, 16) !== minute)
  );
}

/** Perform one schedule's action; unknown actions are ignored. */
export async function runScheduleAction(actions: ScheduleActions, schedule: ServerScheduleRecord): Promise<void> {
  if (schedule.action === 'restart') await actions.restart(schedule.deploymentId);
  else if (schedule.action === 'backup') await actions.backup(schedule.deploymentId);
}

/** Run every due schedule once, stamping lastRunAt. Returns the schedules that ran. */
export async function tickSchedules(repo: Repository, now: Date, actions: ScheduleActions): Promise<ServerScheduleRecord[]> {
  const due = selectDue(await repo.listAllSchedules(), now);
  for (const s of due) {
    try {
      await runScheduleAction(actions, s);
    } catch {
      // A failing schedule must not stop the others; it retries next match.
    }
    await repo.updateSchedule(s.id, { lastRunAt: now.toISOString() });
  }
  return due;
}

/** Start the minute poll. Returns a stop function. */
export function startScheduler(repo: Repository, actions: ScheduleActions, intervalMs = 60_000): () => void {
  const handle = setInterval(() => {
    void tickSchedules(repo, new Date(), actions).catch(() => {});
  }, intervalMs);
  return () => clearInterval(handle);
}
