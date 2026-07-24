import path from 'path';
import { describe, it, expect } from 'vitest';
import { backupRef, isSafeRef, backupFilePath } from './backups.js';

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
