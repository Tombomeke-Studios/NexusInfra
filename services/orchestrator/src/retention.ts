import type { ServerBackupRecord } from './types.js';

// Backup retention (#232) — which backups a server may let go of. Pure: the
// scheduler and the backup routes decide *when* to ask, this decides *what*.
//
// Backups used to accumulate on the node until its disk filled.

export interface BackupRetention {
  /** Keep at most this many. */
  keepLast?: number;
  /** Keep nothing older than this many days. */
  keepDays?: number;
}

export const MAX_KEEP_LAST = 1000;
export const MAX_KEEP_DAYS = 3650;

/**
 * The backups a policy no longer keeps.
 *
 * Both settings are limits, so a backup that breaks either one goes — "keep 7,
 * nothing older than 30 days" means exactly that. The newest backup is always
 * kept, however old: a server that has not been backed up for months should not
 * lose the one copy it has because it is old.
 */
export function expiredBackups(backups: ServerBackupRecord[], policy: BackupRetention, now: Date): ServerBackupRecord[] {
  if (!policy.keepLast && !policy.keepDays) return [];
  const newestFirst = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const cutoff = policy.keepDays ? now.getTime() - policy.keepDays * 86_400_000 : null;
  return newestFirst.filter((b, index) => {
    if (index === 0) return false;
    if (policy.keepLast && index >= policy.keepLast) return true;
    return cutoff !== null && new Date(b.createdAt).getTime() < cutoff;
  });
}

/** Validate a policy from a request. A zero would read as "keep none", so it is refused. */
export function parseRetention(value: unknown): { ok: true; policy: BackupRetention } | { ok: false; error: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'retention must be an object like { "keepLast": 7, "keepDays": 30 }' };
  }
  const input = value as Record<string, unknown>;
  const policy: BackupRetention = {};
  const field = (key: 'keepLast' | 'keepDays', max: number, what: string): string | null => {
    const v = input[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) return `${key} must be a whole number of ${what} from 1 to ${max}`;
    policy[key] = v;
    return null;
  };
  const error = field('keepLast', MAX_KEEP_LAST, 'backups') ?? field('keepDays', MAX_KEEP_DAYS, 'days');
  return error ? { ok: false, error } : { ok: true, policy };
}
