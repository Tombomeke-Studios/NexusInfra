import { describe, it, expect } from 'vitest';
import { normalizeContainerPath, parseLsOutput, buildTarball } from './files.js';

describe('normalizeContainerPath', () => {
  it('makes paths absolute and collapses redundant segments', () => {
    expect(normalizeContainerPath('src//app/.')).toBe('/src/app');
    expect(normalizeContainerPath('')).toBe('/');
    expect(normalizeContainerPath('/')).toBe('/');
  });

  it('never climbs above the container root', () => {
    expect(normalizeContainerPath('../../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeContainerPath('/app/../../../..')).toBe('/');
    expect(normalizeContainerPath('/app/data/../logs')).toBe('/app/logs');
  });
});

describe('parseLsOutput', () => {
  it('parses GNU-style long listing into typed entries, dirs first', () => {
    const raw = [
      'total 20',
      'drwxr-xr-x 2 root root 4096 Jul 24 10:00 src/',
      '-rw-r--r-- 1 root root  512 Jul 24 10:01 Dockerfile',
      'lrwxrwxrwx 1 root root    7 Jul 24 10:02 link -> src/app',
    ].join('\n');
    expect(parseLsOutput(raw)).toEqual([
      { name: 'src', kind: 'dir', size: 4096 },
      { name: 'Dockerfile', kind: 'file', size: 512 },
      { name: 'link', kind: 'file', size: 7 },
    ]);
  });

  it('skips . and .. and blank lines', () => {
    const raw = 'drwxr-xr-x 2 root root 4096 Jul 24 10:00 ./\ndrwxr-xr-x 2 root root 4096 Jul 24 10:00 ../\n\n';
    expect(parseLsOutput(raw)).toEqual([]);
  });
});

describe('buildTarball', () => {
  it('writes a ustar header carrying the file name and octal size', () => {
    const tar = buildTarball('hello.txt', 'hi there');
    expect(tar.length % 512).toBe(0);
    expect(tar.toString('utf8', 0, 9)).toBe('hello.txt');
    expect(tar.toString('ascii', 257, 262)).toBe('ustar');
    // size field (offset 124) is the octal byte length of the content.
    expect(parseInt(tar.toString('ascii', 124, 135).replace(/\0/g, '').trim(), 8)).toBe(8);
    // content sits in the block after the header.
    expect(tar.toString('utf8', 512, 520)).toBe('hi there');
  });

  it('strips a leading slash from the archived name', () => {
    const tar = buildTarball('/etc/motd', 'x');
    expect(tar.toString('utf8', 0, 9)).toBe('etc/motd\0');
  });
});

// Uploads used to be read with file.text() and re-encoded as UTF-8, which replaces
// every invalid byte with U+FFFD — a plugin JAR arrived corrupt while the panel
// reported success (#263).
describe('buildTarball with binary content', () => {
  it('archives raw bytes without touching them', () => {
    // 0xC3 0x28 is invalid UTF-8; 0x00 and 0xFF never survive a text round trip.
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xc3, 0x28, 0x00, 0xff, 0xfe]);
    const tar = buildTarball('plugin.jar', bytes);

    expect(parseInt(tar.toString('ascii', 124, 135).replace(/\0/g, '').trim(), 8)).toBe(bytes.length);
    expect(tar.subarray(512, 512 + bytes.length).equals(bytes)).toBe(true);
  });

  it('still handles text, sized by its encoded byte length', () => {
    // 'é' is two bytes in UTF-8 — the size field must count bytes, not characters.
    const tar = buildTarball('note.txt', 'café');
    expect(parseInt(tar.toString('ascii', 124, 135).replace(/\0/g, '').trim(), 8)).toBe(5);
  });
});
