import path from 'path';
import { describe, it, expect } from 'vitest';
import { backupRef, isSafeRef, backupFilePath, restoreTargetFor } from './backups.js';

describe('backup refs', () => {
  it('generates unique, filesystem-safe references', () => {
    const a = backupRef();
    const b = backupRef();
    expect(a).not.toBe(b);
    expect(isSafeRef(a)).toBe(true);
  });

  it('rejects references that could traverse the backup directory', () => {
    expect(isSafeRef('../etc/passwd')).toBe(false);
    expect(isSafeRef('a/b')).toBe(false);
    expect(isSafeRef('bk_abc-123')).toBe(true);
    expect(isSafeRef('')).toBe(false);
  });

  it('builds the tar path for a safe ref and throws for an unsafe one', () => {
    expect(backupFilePath('/var/backups', 'bk_1')).toBe(path.join('/var/backups', 'bk_1.tar'));
    expect(() => backupFilePath('/var/backups', '../evil')).toThrow('invalid backup reference');
  });
});

describe('restoreTargetFor (#327)', () => {
  // Docker's archive of /data holds entries named data/…, so extracting it into
  // /data wrote /data/data/… and restored nothing. It goes into the parent.
  it('extracts into the parent of the backed-up directory', () => {
    expect(restoreTargetFor('/data')).toBe('/');
    expect(restoreTargetFor('/usr/share/nginx/html')).toBe('/usr/share/nginx');
    expect(restoreTargetFor('/home/steam/cs2-dedicated/')).toBe('/home/steam');
  });
});
