import { posix } from 'path';
// ssh2 is CommonJS: Node's ESM loader cannot see its named exports at run time
// (a test runner's transform hides that), so it is imported whole.
import ssh2 from 'ssh2';
import type { Connection, SFTPWrapper, Attributes, FileEntry as SshFileEntry, Server as SshServer } from 'ssh2';

const { Server, utils } = ssh2;

// SFTP access to a server's files (#235).
//
// A server's files already had an HTTP API (#108), used by the Files tab. SFTP is
// the same operations in the protocol every desktop client speaks — for moving a
// world, a mod pack or a plugin folder, which the browser is bad at. So this is a
// second front door to the *same* back end, and nothing here decides anything the
// HTTP API does not:
//
// - **Who gets in** is an account (its password, or an `nxi_` API token) plus the
//   server it names, and the account must hold `file.read` there — the same
//   permission the Files tab needs.
// - **What they may change** is `file.write`, checked on every change rather than
//   once at login, so revoking a share ends write access in an open session too.
// - **Where the bytes go** is the owning node's agent, through the same internal
//   file API, so a path is normalised and contained there exactly as it is for the
//   panel.
//
// This file is the protocol half, over an injected `SftpFiles`: pure enough to be
// tested with a real SSH client against an in-memory file system. `sftpBackend.ts`
// is the half that talks to accounts and agents.

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

/** A failure that maps onto an SFTP status, so the client shows the right thing. */
export class SftpError extends Error {
  constructor(
    readonly code: 'NO_SUCH_FILE' | 'PERMISSION_DENIED' | 'FAILURE' | 'OP_UNSUPPORTED',
    message: string
  ) {
    super(message);
  }
}

export interface SftpEntry {
  name: string;
  kind: 'file' | 'dir';
  size: number;
}

/** One authenticated session's view of one server's files. Every method re-checks access. */
export interface SftpFiles {
  /** Throws PERMISSION_DENIED unless the session may change files now. */
  assertWritable(): Promise<void>;
  list(dir: string): Promise<SftpEntry[]>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or a directory (with its contents). */
  remove(path: string): Promise<void>;
}

export interface SftpIdentity {
  userId: string;
  email: string;
  deploymentId: string;
  /** False for a read-only API token: the account may write, this credential may not. */
  credentialAllowsWrite: boolean;
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

/**
 * Split an SFTP login name into the account and the server it is for.
 *
 * `<email>.<server>` — the server is its id, or the first eight characters of it
 * (what the panel shows). Split on the *last* dot, because an email has dots in it
 * and a server id never does.
 */
export function parseSftpUsername(username: string): { email: string; server: string } | null {
  const at = username.lastIndexOf('.');
  if (at <= 0 || at === username.length - 1) return null;
  const email = username.slice(0, at).trim().toLowerCase();
  const server = username.slice(at + 1).trim();
  if (!email.includes('@') || !/^[A-Za-z0-9_-]+$/.test(server)) return null;
  return { email, server };
}

/** The login name the panel shows for one account on one server. */
export function sftpUsernameFor(email: string, deploymentId: string): string {
  return `${email}.${deploymentId.slice(0, 8)}`;
}

/** A TCP port from the environment, or null for unset or nonsense (which leaves SFTP off). */
export function parseSftpPort(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** An absolute, normalised path; `..` never climbs above `/`. */
export function resolveSftpPath(path: string, base = '/'): string {
  const joined = posix.resolve('/', base, path || '.');
  return posix.normalize(joined);
}

const DIR_MODE = 0o040755;
const FILE_MODE = 0o100644;

/**
 * SFTP attributes for an entry. The agent's listing has no times, so they are 0
 * rather than a made-up "now" — a sync tool comparing times would otherwise see
 * every file as changed on every listing.
 */
export function attrsFor(entry: Pick<SftpEntry, 'kind' | 'size'>): Attributes {
  return { mode: entry.kind === 'dir' ? DIR_MODE : FILE_MODE, uid: 0, gid: 0, size: entry.size, atime: 0, mtime: 0 };
}

/** The `ls -l`-style line a client shows for an entry. */
export function longnameFor(entry: SftpEntry): string {
  const perms = entry.kind === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
  return `${perms}    1 server   server   ${String(entry.size).padStart(12)} Jan  1  1970 ${entry.name}`;
}

/**
 * What an OPEN asks for, from its flags. Pure, so every combination a client can
 * send is tested: the difference between "truncate" and "start from what is
 * there" is the difference between an upload and a corrupted file.
 */
export function openIntent(flags: number): { read: boolean; write: boolean; truncate: boolean; create: boolean; exclusive: boolean; append: boolean } {
  return {
    read: (flags & OPEN_MODE.READ) !== 0,
    write: (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND)) !== 0,
    truncate: (flags & OPEN_MODE.TRUNC) !== 0,
    create: (flags & OPEN_MODE.CREAT) !== 0,
    exclusive: (flags & OPEN_MODE.EXCL) !== 0,
    append: (flags & OPEN_MODE.APPEND) !== 0,
  };
}

/**
 * A file being written: chunks land at their offsets, in any order (clients
 * pipeline writes), and the whole is uploaded on close. Capped, because it is
 * held in memory — the same reason the HTTP upload is.
 */
export class WriteBuffer {
  private buf: Buffer;
  size: number;

  constructor(
    initial: Buffer,
    private readonly maxBytes: number
  ) {
    this.buf = Buffer.from(initial);
    this.size = initial.length;
  }

  write(offset: number, data: Buffer): void {
    const end = offset + data.length;
    if (end > this.maxBytes) {
      throw new SftpError('FAILURE', `a file sent over SFTP may be at most ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
    }
    if (end > this.buf.length) {
      const grown = Buffer.alloc(Math.min(this.maxBytes, Math.max(end, this.buf.length * 2)));
      this.buf.copy(grown, 0, 0, this.size);
      this.buf = grown;
    }
    data.copy(this.buf, offset);
    this.size = Math.max(this.size, end);
  }

  contents(): Buffer {
    return this.buf.subarray(0, this.size);
  }
}

// ── The server ─────────────────────────────────────────────────────────────────

export interface SftpServerDeps {
  hostKey: string | Buffer;
  /** Resolve a login, or null to refuse it. Rate limiting is its business. */
  authenticate(username: string, password: string, ip: string): Promise<SftpIdentity | null>;
  filesFor(identity: SftpIdentity): SftpFiles;
  /** Largest file one upload may be; held in memory until the handle closes. */
  maxWriteBytes?: number;
  onLogin?(identity: SftpIdentity, ip: string): void;
  log?(message: string): void;
}

type Handle =
  | { kind: 'read'; path: string; data: Buffer }
  | { kind: 'write'; path: string; buffer: WriteBuffer; dirty: boolean; append: boolean; failed: boolean }
  | { kind: 'dir'; path: string; done: boolean };

const statusOf = (err: unknown): { code: number; message: string } => {
  if (err instanceof SftpError) return { code: STATUS_CODE[err.code], message: err.message };
  return { code: STATUS_CODE.FAILURE, message: err instanceof Error ? err.message : String(err) };
};

export function createSftpServer(deps: SftpServerDeps): SshServer {
  const maxWriteBytes = deps.maxWriteBytes ?? 64 * 1024 * 1024;
  const log = deps.log ?? ((m: string) => console.log(`[Orchestrator] sftp: ${m}`));

  // Shown before the password prompt by clients that show banners: the one place to
  // say what the user name is and why a password might be refused.
  const banner = [
    'NexusInfra SFTP',
    'User name: <your account email>.<server id> (shown on the server\'s Files tab).',
    'Password: your account password, or an API token. Accounts with two-factor sign-in must use an API token.',
    '',
  ].join('\r\n');

  return new Server({ hostKeys: [deps.hostKey], banner }, (client: Connection, info) => {
    let identity: SftpIdentity | null = null;

    client.on('authentication', (ctx) => {
      // Password only: there is no key store to check a public key against, and
      // offering "none" or keyboard-interactive would only be a second prompt.
      if (ctx.method !== 'password') return ctx.reject(['password']);
      deps
        .authenticate(ctx.username, ctx.password, info.ip)
        .then((who) => {
          if (!who) return ctx.reject(['password']);
          identity = who;
          ctx.accept();
        })
        .catch((err) => {
          log(`authentication failed with an error: ${err instanceof Error ? err.message : err}`);
          ctx.reject(['password']);
        });
    });

    client.on('ready', () => {
      const who = identity!;
      deps.onLogin?.(who, info.ip);
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        // No shell and no exec: this is a file door, not a console (#68 is the console).
        session.on('pty', (_accept, reject) => reject?.());
        session.on('shell', (_accept, reject) => reject?.());
        session.on('exec', (_accept, reject) => reject?.());
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), deps.filesFor(who), maxWriteBytes));
      });
    });

    client.on('error', (err) => log(`connection from ${info.ip}: ${err.message}`));
  });
}

function serveSftp(sftp: SFTPWrapper, files: SftpFiles, maxWriteBytes: number): void {
  const handles = new Map<number, Handle>();
  let nextHandle = 1;
  const open = (h: Handle): Buffer => {
    const id = nextHandle++;
    handles.set(id, h);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id, 0);
    return b;
  };
  const handleOf = (raw: Buffer) => (raw.length === 4 ? handles.get(raw.readUInt32BE(0)) : undefined);
  const badHandle = (reqid: number) => sftp.status(reqid, STATUS_CODE.FAILURE, 'invalid handle');
  const fail = (reqid: number, err: unknown) => {
    const { code, message } = statusOf(err);
    sftp.status(reqid, code, message);
  };

  /** One entry, found by listing its directory — the agent has no stat of its own. */
  const stat = async (path: string): Promise<SftpEntry> => {
    if (path === '/') return { name: '/', kind: 'dir', size: 0 };
    const entry = (await files.list(posix.dirname(path))).find((e) => e.name === posix.basename(path));
    if (!entry) throw new SftpError('NO_SUCH_FILE', `no such file: ${path}`);
    return entry;
  };

  // Every request runs to a single status/answer; a thrown error becomes a status.
  const run = (reqid: number, work: () => Promise<void>) => {
    work().catch((err) => fail(reqid, err));
  };

  sftp.on('REALPATH', (reqid, path) => {
    const resolved = resolveSftpPath(path);
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrsFor({ kind: 'dir', size: 0 }) }]);
  });

  const onStat = (reqid: number, path: string) =>
    run(reqid, async () => {
      sftp.attrs(reqid, attrsFor(await stat(resolveSftpPath(path))));
    });
  sftp.on('STAT', onStat);
  sftp.on('LSTAT', onStat);

  sftp.on('OPENDIR', (reqid, path) =>
    run(reqid, async () => {
      const dir = resolveSftpPath(path);
      // Listing now, rather than on the first READDIR, is what turns "not a
      // directory" and "no access" into an answer to the OPENDIR that asked.
      if ((await stat(dir)).kind !== 'dir') throw new SftpError('FAILURE', `not a directory: ${dir}`);
      sftp.handle(reqid, open({ kind: 'dir', path: dir, done: false }));
    })
  );

  sftp.on('READDIR', (reqid, raw) => {
    const h = handleOf(raw);
    if (!h || h.kind !== 'dir') return badHandle(reqid);
    if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
    run(reqid, async () => {
      const entries = await files.list(h.path);
      h.done = true;
      const names: SshFileEntry[] = entries.map((e) => ({ filename: e.name, longname: longnameFor(e), attrs: attrsFor(e) }));
      if (names.length === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.name(reqid, names);
    });
  });

  sftp.on('OPEN', (reqid, filename, flags) =>
    run(reqid, async () => {
      const path = resolveSftpPath(filename);
      const intent = openIntent(flags);

      if (!intent.write) {
        sftp.handle(reqid, open({ kind: 'read', path, data: await readExisting(path, true) }));
        return;
      }

      await files.assertWritable();
      let existing: Buffer | null = null;
      if (!intent.truncate || intent.exclusive || !intent.create) existing = await readExisting(path, false);
      if (intent.exclusive && existing) throw new SftpError('FAILURE', `already exists: ${path}`);
      if (!existing && !intent.create) throw new SftpError('NO_SUCH_FILE', `no such file: ${path}`);

      const initial = intent.truncate || !existing ? Buffer.alloc(0) : existing;
      // Creating or truncating is a change even if nothing is written: an empty
      // upload must leave an empty file behind.
      sftp.handle(reqid, open({ kind: 'write', path, buffer: new WriteBuffer(initial, maxWriteBytes), dirty: intent.truncate || !existing, append: intent.append, failed: false }));
    })
  );

  /** The file's bytes; null when it is not there and `required` is false. */
  async function readExisting(path: string, required: true): Promise<Buffer>;
  async function readExisting(path: string, required: false): Promise<Buffer | null>;
  async function readExisting(path: string, required: boolean): Promise<Buffer | null> {
    try {
      return await files.read(path);
    } catch (err) {
      if (!required && err instanceof SftpError && err.code === 'NO_SUCH_FILE') return null;
      throw err;
    }
  }

  sftp.on('READ', (reqid, raw, offset, length) => {
    const h = handleOf(raw);
    if (!h || h.kind === 'dir') return badHandle(reqid);
    const data = h.kind === 'read' ? h.data : h.buffer.contents();
    if (offset >= data.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, data.subarray(offset, Math.min(data.length, offset + length)));
  });

  sftp.on('WRITE', (reqid, raw, offset, data) => {
    const h = handleOf(raw);
    if (!h || h.kind !== 'write') return badHandle(reqid);
    try {
      // In append mode the offset is ignored and every write lands at the end.
      h.buffer.write(h.append ? h.buffer.size : offset, data);
      h.dirty = true;
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err) {
      // One lost chunk makes the whole file wrong. Remember it, so the close that
      // follows does not upload what did arrive over the file that was there.
      h.failed = true;
      fail(reqid, err);
    }
  });

  sftp.on('FSTAT', (reqid, raw) => {
    const h = handleOf(raw);
    if (!h) return badHandle(reqid);
    if (h.kind === 'dir') return sftp.attrs(reqid, attrsFor({ kind: 'dir', size: 0 }));
    sftp.attrs(reqid, attrsFor({ kind: 'file', size: h.kind === 'read' ? h.data.length : h.buffer.size }));
  });

  sftp.on('CLOSE', (reqid, raw) => {
    const id = raw.length === 4 ? raw.readUInt32BE(0) : -1;
    const h = handles.get(id);
    if (!h) return badHandle(reqid);
    handles.delete(id);
    if (h.kind !== 'write' || !h.dirty) return sftp.status(reqid, STATUS_CODE.OK);
    if (h.failed) return sftp.status(reqid, STATUS_CODE.FAILURE, `not saved: part of ${h.path} could not be written, so the file was left as it was`);
    // The upload happens here, so this is where a failure is reported — a client
    // that sees CLOSE fail knows the file did not arrive.
    run(reqid, async () => {
      await files.write(h.path, h.buffer.contents());
      sftp.status(reqid, STATUS_CODE.OK);
    });
  });

  sftp.on('MKDIR', (reqid, path) =>
    run(reqid, async () => {
      await files.mkdir(resolveSftpPath(path));
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('RENAME', (reqid, from, to) =>
    run(reqid, async () => {
      await files.rename(resolveSftpPath(from), resolveSftpPath(to));
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  // The agent removes recursively; SFTP's REMOVE and RMDIR do not. Checked here,
  // so a client's "remove this file" can never take a directory with it and its
  // "remove this empty directory" can never take a full one.
  sftp.on('REMOVE', (reqid, path) =>
    run(reqid, async () => {
      const target = resolveSftpPath(path);
      await files.assertWritable();
      if ((await stat(target)).kind === 'dir') throw new SftpError('FAILURE', `is a directory: ${target}`);
      await files.remove(target);
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('RMDIR', (reqid, path) =>
    run(reqid, async () => {
      const target = resolveSftpPath(path);
      if (target === '/') throw new SftpError('PERMISSION_DENIED', 'the root directory cannot be removed');
      await files.assertWritable();
      if ((await stat(target)).kind !== 'dir') throw new SftpError('FAILURE', `not a directory: ${target}`);
      if ((await files.list(target)).length > 0) throw new SftpError('FAILURE', `directory not empty: ${target}`);
      await files.remove(target);
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  // Clients set times and modes after an upload. The agent keeps neither, and
  // refusing would make them report the upload itself as failed — so it is
  // acknowledged, and nothing more.
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));

  const unsupported = (reqid: number) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED, 'links are not supported');
  sftp.on('READLINK', unsupported);
  sftp.on('SYMLINK', unsupported);
}
