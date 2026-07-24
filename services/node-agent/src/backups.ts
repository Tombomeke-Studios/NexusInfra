import path from 'path';

// Pure helpers for the backup store (#110). A backup is a tar the agent writes to
// its backup directory under an opaque ref; these keep the ref filesystem-safe so
// a crafted ref can't escape the backup dir.

// The container path snapshotted by default — a server's persistent data lives here.
export const DEFAULT_BACKUP_PATH = '/data';

/** A fresh opaque backup reference (used as the tar's filename stem). */
export function backupRef(): string {
  return `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** True for a ref that is safe to use as a single path segment (no traversal). */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(ref);
}

/** Resolve the on-disk tar path for a ref, rejecting anything that could traverse. */
export function backupFilePath(dir: string, ref: string): string {
  if (!isSafeRef(ref)) throw new Error('invalid backup reference');
  return path.join(dir, `${ref}.tar`);
}
