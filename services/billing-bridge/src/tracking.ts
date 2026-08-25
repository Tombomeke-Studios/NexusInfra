// Pure runtime-tracking math. A server accrues billable time as (start, stop)
// intervals; the Billing Bridge opens an interval on server.started and closes it
// on server.stopped. Summing closed intervals gives the hours a cycle charges on.

const MS_PER_HOUR = 1000 * 60 * 60;

/** Hours between two ISO timestamps (fractional), floored at zero for bad ordering. */
export function hoursBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return ms > 0 ? ms / MS_PER_HOUR : 0;
}

export interface RuntimeInterval {
  startedAt: string;
  /** null while the server is still running. */
  stoppedAt: string | null;
}

/**
 * Total accrued hours across intervals. An open interval (no stoppedAt) is
 * counted up to `now` so live usage is visible mid-cycle.
 */
export function accruedHours(intervals: RuntimeInterval[], now: string = new Date().toISOString()): number {
  return intervals.reduce((sum, i) => sum + hoursBetween(i.startedAt, i.stoppedAt ?? now), 0);
}
