// Pure helpers for the container file-management API (#108). The Docker exec /
// archive plumbing lives in runtime.ts; everything here is side-effect-free and
// unit-tested — most importantly the path guard, since these paths are handed to
// commands running inside a user's container.

export interface FileEntry {
  name: string;
  kind: 'file' | 'dir';
  size: number;
}

/**
 * Normalise a container path to an absolute, traversal-safe form. `.` and `..`
 * segments are resolved away and can never climb above `/`, so a crafted
 * `../../etc/passwd` collapses to `/etc/passwd` (still inside the container, never
 * the host) rather than escaping. Always returns a path starting with `/`.
 */
export function normalizeContainerPath(input: string): string {
  const raw = (input || '/').replace(/\\/g, '/');
  const stack: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return '/' + stack.join('/');
}

/**
 * Parse the output of `ls -lAp` into entries. Kind comes from the permission
 * block's first char (`d` = directory), which is more reliable than the trailing
 * slash; symlink targets (`name -> target`) and the `total` header are stripped.
 */
export function parseLsOutput(raw: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const line of raw.split('\n')) {
    const l = line.replace(/\r$/, '');
    if (!l.trim() || /^total\s/.test(l)) continue;
    const cols = l.trim().split(/\s+/);
    if (cols.length < 9) continue;

    const perms = cols[0];
    const size = Number(cols[4]) || 0;
    let name = cols.slice(8).join(' ');

    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) name = name.slice(0, arrow); // drop symlink target
    const isDir = perms[0] === 'd' || name.endsWith('/');
    name = name.replace(/\/$/, '');
    if (name === '' || name === '.' || name === '..') continue;

    out.push({ name, kind: isDir ? 'dir' : 'file', size });
  }
  // Directories first, then alphabetical — the order the Files tab renders.
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
}

/**
 * Build a minimal (single-file, ustar) tarball for Docker's putArchive. Enough of
 * the header is filled in — name, mode, size, mtime, checksum — for the daemon to
 * extract one regular file; the stream is terminated with the two zero blocks.
 */
/**
 * A single-file ustar archive, for putArchive into a container.
 *
 * `content` is either text or raw bytes. Bytes matter: an upload read as text and
 * re-encoded loses every byte that is not valid UTF-8, which silently corrupts
 * anything binary (#263). Buffer.from(buffer) copies verbatim.
 */
export function buildTarball(fileName: string, content: string | Buffer): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);

  header.write(fileName.replace(/^\//, '').slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100, 'ascii'); // mode
  header.write('0000000\0', 108, 'ascii'); // uid
  header.write('0000000\0', 116, 'ascii'); // gid
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii'); // size
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii'); // mtime
  header.write('        ', 148, 'ascii'); // checksum field starts as spaces
  header.write('0', 156, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 'binary');
  header.write('00', 263, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(body);
  return Buffer.concat([header, body, Buffer.alloc(1024, 0)]);
}
