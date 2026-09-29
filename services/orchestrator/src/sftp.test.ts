import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AddressInfo } from 'net';
import { posix } from 'path';
import ssh2, { type SFTPWrapper } from 'ssh2';
import {
  attrsFor,
  createSftpServer,
  openIntent,
  parseSftpPort,
  parseSftpUsername,
  resolveSftpPath,
  SftpError,
  sftpUsernameFor,
  WriteBuffer,
  type SftpEntry,
  type SftpFiles,
  type SftpIdentity,
} from './sftp.js';

const { Client, utils } = ssh2;
const { OPEN_MODE } = utils.sftp;

describe('parseSftpUsername', () => {
  it('splits on the last dot, since the email has dots of its own', () => {
    expect(parseSftpUsername('ada.lovelace@example.co.uk.1a2b3c4d')).toEqual({ email: 'ada.lovelace@example.co.uk', server: '1a2b3c4d' });
  });

  it('accepts a full server id and lower-cases the email', () => {
    expect(parseSftpUsername('Ada@Example.com.1a2b3c4d-0000-4000-8000-000000000000')).toEqual({
      email: 'ada@example.com',
      server: '1a2b3c4d-0000-4000-8000-000000000000',
    });
  });

  it('refuses a name with no server, no email, or characters no id has', () => {
    for (const bad of ['ada@example', 'ada@example.', 'adaexample.1a2b3c4d', '.1a2b3c4d', 'ada@example.com.1a2b/../x']) {
      expect(parseSftpUsername(bad)).toBeNull();
    }
  });

  it('round-trips with the name the panel shows', () => {
    const id = '1a2b3c4d-0000-4000-8000-000000000000';
    expect(parseSftpUsername(sftpUsernameFor('ada@example.com', id))).toEqual({ email: 'ada@example.com', server: '1a2b3c4d' });
  });
});

describe('resolveSftpPath', () => {
  it('makes paths absolute and never climbs above the root', () => {
    expect(resolveSftpPath('.')).toBe('/');
    expect(resolveSftpPath('')).toBe('/');
    expect(resolveSftpPath('data/world')).toBe('/data/world');
    expect(resolveSftpPath('../../etc/passwd')).toBe('/etc/passwd');
    expect(resolveSftpPath('/data//./x/../y/')).toBe('/data/y');
  });
});

describe('parseSftpPort', () => {
  it('reads a port and leaves SFTP off for anything else', () => {
    expect(parseSftpPort('2022')).toBe(2022);
    for (const v of [undefined, '', ' ', 'abc', '0', '70000', '22.5']) expect(parseSftpPort(v)).toBeNull();
  });
});

describe('openIntent', () => {
  it('reads the flags an upload, a download, a resume and an append send', () => {
    expect(openIntent(OPEN_MODE.READ)).toMatchObject({ read: true, write: false });
    expect(openIntent(OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)).toMatchObject({ write: true, create: true, truncate: true });
    expect(openIntent(OPEN_MODE.WRITE)).toMatchObject({ write: true, create: false, truncate: false });
    expect(openIntent(OPEN_MODE.APPEND | OPEN_MODE.CREAT)).toMatchObject({ write: true, append: true });
  });
});

describe('attrsFor', () => {
  it('marks directories and files by mode, and reports no invented times', () => {
    expect(attrsFor({ kind: 'dir', size: 0 }).mode & 0o170000).toBe(0o040000);
    expect(attrsFor({ kind: 'file', size: 9 })).toMatchObject({ mode: 0o100644, size: 9, mtime: 0 });
  });
});

describe('WriteBuffer', () => {
  it('places chunks at their offsets, in any order', () => {
    const b = new WriteBuffer(Buffer.alloc(0), 1024);
    b.write(5, Buffer.from('world'));
    b.write(0, Buffer.from('hello'));
    expect(b.contents().toString()).toBe('helloworld');
  });

  it('starts from existing content and overwrites in place', () => {
    const b = new WriteBuffer(Buffer.from('abcdef'), 1024);
    b.write(2, Buffer.from('XY'));
    expect(b.contents().toString()).toBe('abXYef');
  });

  it('refuses to grow past its cap', () => {
    const b = new WriteBuffer(Buffer.alloc(0), 8);
    expect(() => b.write(4, Buffer.from('12345'))).toThrow(SftpError);
  });
});

// ── The protocol, end to end: a real SSH client against the server ─────────────

/** An in-memory file system with the same contract as the agent-backed one. */
class MemoryFiles implements SftpFiles {
  files = new Map<string, Buffer>();
  dirs = new Set<string>(['/']);
  writable = true;

  async assertWritable() {
    if (!this.writable) throw new SftpError('PERMISSION_DENIED', 'your role on this server cannot change files');
  }
  async list(dir: string): Promise<SftpEntry[]> {
    if (!this.dirs.has(dir)) throw new SftpError('NO_SUCH_FILE', `no such directory: ${dir}`);
    const out: SftpEntry[] = [];
    for (const d of this.dirs) if (d !== '/' && posix.dirname(d) === dir) out.push({ name: posix.basename(d), kind: 'dir', size: 0 });
    for (const [f, data] of this.files) if (posix.dirname(f) === dir) out.push({ name: posix.basename(f), kind: 'file', size: data.length });
    return out;
  }
  async read(path: string) {
    const data = this.files.get(path);
    if (!data) throw new SftpError(this.dirs.has(path) ? 'FAILURE' : 'NO_SUCH_FILE', `no such file: ${path}`);
    return data;
  }
  async write(path: string, data: Buffer) {
    await this.assertWritable();
    this.files.set(path, Buffer.from(data));
  }
  async mkdir(path: string) {
    await this.assertWritable();
    this.dirs.add(path);
  }
  async rename(from: string, to: string) {
    await this.assertWritable();
    const data = this.files.get(from);
    if (!data) throw new SftpError('NO_SUCH_FILE', `no such file: ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }
  async remove(path: string) {
    await this.assertWritable();
    this.files.delete(path);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
    for (const f of [...this.files.keys()]) if (f.startsWith(`${path}/`)) this.files.delete(f);
  }
}

describe('SFTP server', () => {
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const identity: SftpIdentity = { userId: 'u1', email: 'ada@example.com', deploymentId: 'd1', credentialAllowsWrite: true };
  let files: MemoryFiles;
  let port: number;
  let logins: string[];
  let server: ReturnType<typeof createSftpServer>;

  beforeAll(async () => {
    server = createSftpServer({
      hostKey,
      maxWriteBytes: 1024 * 1024,
      authenticate: async (username, password) => (username === 'ada@example.com.d1' && password === 'right' ? identity : null),
      filesFor: () => files,
      onLogin: (who) => logins.push(who.email),
      log: () => undefined,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    files = new MemoryFiles();
    files.dirs.add('/data');
    files.files.set('/data/server.properties', Buffer.from('motd=hi\n'));
    logins = [];
  });

  function connect(password = 'right'): Promise<{ sftp: SFTPWrapper; client: InstanceType<typeof Client> }> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      client
        .on('ready', () => client.sftp((err, sftp) => (err ? reject(err) : resolve({ sftp, client }))))
        .on('error', reject)
        .connect({ host: '127.0.0.1', port, username: 'ada@example.com.d1', password, readyTimeout: 5000 });
    });
  }
  const p = <T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) =>
    new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));

  it('refuses a wrong password', async () => {
    await expect(connect('wrong')).rejects.toThrow(/authentication/i);
    expect(logins).toEqual([]);
  });

  it('lists, downloads and uploads — binary bytes untouched', async () => {
    const { sftp, client } = await connect();
    try {
      expect(logins).toEqual(['ada@example.com']);
      const list = await p<Array<{ filename: string; attrs: { size: number } }>>((cb) => sftp.readdir('/data', cb));
      expect(list.map((e) => [e.filename, e.attrs.size])).toEqual([['server.properties', 8]]);

      const got = await p<Buffer>((cb) => sftp.readFile('/data/server.properties', cb));
      expect(got.toString()).toBe('motd=hi\n');

      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xc3, 0x28]);
      // Larger than one SFTP packet, so it arrives as several pipelined writes.
      const big = Buffer.concat(Array.from({ length: 20000 }, () => bytes));
      await p((cb) => sftp.writeFile('/data/mods.jar', big, cb));
      expect(Buffer.compare(files.files.get('/data/mods.jar')!, big)).toBe(0);
    } finally {
      client.end();
    }
  });

  it('creates an empty file from an upload with no bytes', async () => {
    const { sftp, client } = await connect();
    try {
      await p((cb) => sftp.writeFile('/data/empty.txt', Buffer.alloc(0), cb));
      expect(files.files.get('/data/empty.txt')?.length).toBe(0);
    } finally {
      client.end();
    }
  });

  it('appends at the end whatever offset the client sends', async () => {
    const { sftp, client } = await connect();
    try {
      await p((cb) => sftp.appendFile('/data/server.properties', 'pvp=false\n', cb));
      expect(files.files.get('/data/server.properties')!.toString()).toBe('motd=hi\npvp=false\n');
    } finally {
      client.end();
    }
  });

  it('makes directories, renames, and answers stat', async () => {
    const { sftp, client } = await connect();
    try {
      await p((cb) => sftp.mkdir('/data/world', cb));
      await p((cb) => sftp.rename('/data/server.properties', '/data/world/server.properties', cb));
      const st = await p<{ isDirectory(): boolean }>((cb) => sftp.stat('/data/world', cb));
      expect(st.isDirectory()).toBe(true);
      const f = await p<{ isFile(): boolean; size: number }>((cb) => sftp.stat('/data/world/server.properties', cb));
      expect(f.isFile() && f.size).toBe(8);
      await expect(p((cb) => sftp.stat('/data/nope', cb))).rejects.toThrow(/no such file/i);
    } finally {
      client.end();
    }
  });

  // The agent removes recursively; SFTP does not, and a client relies on that.
  it('will not remove a directory as a file, or a directory that is not empty', async () => {
    const { sftp, client } = await connect();
    try {
      await expect(p((cb) => sftp.unlink('/data', cb))).rejects.toThrow(/is a directory/);
      await expect(p((cb) => sftp.rmdir('/data', cb))).rejects.toThrow(/not empty/);
      expect(files.files.has('/data/server.properties')).toBe(true);

      await p((cb) => sftp.unlink('/data/server.properties', cb));
      await p((cb) => sftp.rmdir('/data', cb));
      expect(files.dirs.has('/data')).toBe(false);
    } finally {
      client.end();
    }
  });

  it('refuses every change to a session without file.write, and still lets it read', async () => {
    files.writable = false;
    const { sftp, client } = await connect();
    try {
      await expect(p((cb) => sftp.writeFile('/data/x', 'x', cb))).rejects.toThrow(/cannot change files/);
      await expect(p((cb) => sftp.mkdir('/data/x', cb))).rejects.toThrow(/cannot change files/);
      await expect(p((cb) => sftp.unlink('/data/server.properties', cb))).rejects.toThrow(/cannot change files/);
      expect((await p<Buffer>((cb) => sftp.readFile('/data/server.properties', cb))).toString()).toBe('motd=hi\n');
      expect(files.files.size).toBe(1);
    } finally {
      client.end();
    }
  });

  it('reports a failed upload on close, so the client knows the file did not arrive', async () => {
    const { sftp, client } = await connect();
    files.write = async () => {
      throw new SftpError('FAILURE', 'the node this server runs on cannot be reached');
    };
    try {
      await expect(p((cb) => sftp.writeFile('/data/x', 'x', cb))).rejects.toThrow(/cannot be reached/);
    } finally {
      client.end();
    }
  });

  it('refuses an upload larger than the cap', async () => {
    const { sftp, client } = await connect();
    try {
      await expect(p((cb) => sftp.writeFile('/data/big', Buffer.alloc(2 * 1024 * 1024), cb))).rejects.toThrow(/at most 1 MB/);
      expect(files.files.has('/data/big')).toBe(false);
      // Nor may a failed overwrite leave the first part of the new file in place of the old one.
      await expect(p((cb) => sftp.writeFile('/data/server.properties', Buffer.alloc(2 * 1024 * 1024, 1), cb))).rejects.toThrow();
      expect(files.files.get('/data/server.properties')!.toString()).toBe('motd=hi\n');
    } finally {
      client.end();
    }
  });

  it('offers no shell or command execution', async () => {
    const { client } = await connect();
    try {
      await expect(p((cb) => client.exec('id', cb))).rejects.toThrow();
    } finally {
      client.end();
    }
  });
});
