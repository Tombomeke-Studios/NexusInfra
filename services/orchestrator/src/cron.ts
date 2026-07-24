// Minimal 5-field cron matcher for the schedule runner (#111). Fields are
// minute hour day-of-month month day-of-week, each supporting `*`, lists (`1,15`),
// ranges (`1-5`), steps (`*/5`, `0-30/10`) and (for dow) both 0 and 7 as Sunday.
// Pure and side-effect-free so scheduling decisions are unit-tested; the loop that
// calls it lives in scheduler.ts.

// Parse one field into the set of matching integer values within [min, max].
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) continue;

    let lo = min;
    let hi = max;
    if (rangePart !== '*' && rangePart !== '') {
      const [a, b] = rangePart.split('-');
      lo = parseInt(a, 10);
      hi = b !== undefined ? parseInt(b, 10) : lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    }
    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return out;
}

/** True if `expr` (a 5-field cron string) fires at the given date (minute resolution). */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  const doms = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const dows = parseField(fields[4], 0, 7);

  const dow = date.getUTCDay(); // 0 = Sunday
  const domMatch = doms.has(date.getUTCDate());
  // Cron convention: both 0 and 7 mean Sunday.
  const dowMatch = dows.has(dow) || (dow === 0 && dows.has(7));
  // When both day-of-month and day-of-week are restricted, either matching fires.
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;

  return minutes.has(date.getUTCMinutes()) && hours.has(date.getUTCHours()) && months.has(date.getUTCMonth() + 1) && dayMatch;
}

/** Validate a 5-field cron string (used to reject bad input at the API boundary). */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.every((f, i) => parseField(f, bounds[i][0], bounds[i][1]).size > 0);
}
