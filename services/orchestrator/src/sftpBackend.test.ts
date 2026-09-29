import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InMemoryRepository } from './repository.js';
import { createUserService, hashPassword } from './users.js';
import { createLoginLimiter } from './loginLimiter.js';
import { generateApiToken } from './apiTokens.js';
import { createAgentSftpFiles, createSftpAuthenticator, findServer, loadOrCreateHostKey } from './sftpBackend.js';
import type { SftpIdentity } from './sftp.js';

// The account and agent side of SFTP (#235): who may log in to which server, and
// that every file operation is authorized again and reaches the owning node.

const PASSWORD = 'correct horse battery';

describe('findServer', () => {
  const list = [{ id: '1a2b3c4d-aaaa' }, { id: '1a2b3c4d-bbbb' }, { id: '9f8e7d6c-cccc' }];
  it('takes a full id or an unambiguous prefix of eight or more', () => {
    expect(findServer(list, '1a2b3c4d-bbbb')).toBe('1a2b3c4d-bbbb');
    expect(findServer(list, '9f8e7d6c')).toBe('9f8e7d6c-cccc');
  });
  it('refuses an ambiguous or too-short prefix rather than guessing', () => {
    expect(findServer(list, '1a2b3c4d')).toBeNull();
    expect(findServer(list, '9f8e')).toBeNull();
    expect(findServer(list, 'deadbeef')).toBeNull();
  });
});

describe('SFTP authentication and file access', () => {
  let repo: InMemoryRepository;
  let deploymentId: string;
  let totpRequired: boolean;
  let authenticate: ReturnType<typeof createSftpAuthenticator>;
  // bcrypt is slow on purpose; hash once, not four times per test.
  let passwordHash: string;
  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  function account(id: string, email: string) {
    return repo.createUser({ id, email, displayName: id, passwordHash, platformRole: 'user' });
  }

  beforeEach(async () => {
    repo = new InMemoryRepository();
    totpRequired = false;
    await account('owner', 'owner@example.com');
    await account('op', 'op@example.com');
    await account('viewer', 'viewer@example.com');
    await account('stranger', 'stranger@example.com');
    const config = await repo.createServerConfig({ userId: 'owner', name: 'mc', dockerImage: 'itzg/minecraft-server', type: 'game' });
    deploymentId = (await repo.createDeployment(config.id, 'node-1')).id;
    await repo.updateDeploymentStatus(deploymentId, { status: 'running', containerId: 'c1' });
    await repo.createSubuser({ deploymentId, email: 'op@example.com', role: 'operator', userId: 'op', status: 'active' });
    await repo.createSubuser({ deploymentId, email: 'viewer@example.com', role: 'viewer', userId: 'viewer', status: 'active' });
    authenticate = createSftpAuthenticator({
      repo,
      users: createUserService({ repo }),
      limiter: createLoginLimiter({ maxAttempts: 3 }),
      totpRequired: () => totpRequired,
    });
  });

  const login = (email: string, secret = PASSWORD, server = deploymentId.slice(0, 8)) => authenticate(`${email}.${server}`, secret, '10.0.0.1');

  it('lets the owner in with their password, able to write', async () => {
    expect(await login('owner@example.com')).toEqual({ userId: 'owner', email: 'owner@example.com', deploymentId, credentialAllowsWrite: true });
  });

  it('lets in anyone holding file.read, and nobody else', async () => {
    expect(await login('op@example.com')).toMatchObject({ userId: 'op' });
    // A viewer may watch the console, not read the files — the Files tab's rule.
    expect(await login('viewer@example.com')).toBeNull();
    expect(await login('stranger@example.com')).toBeNull();
  });

  it('refuses a wrong password, an unknown server and a malformed name alike', async () => {
    expect(await login('owner@example.com', 'wrong password')).toBeNull();
    expect(await login('owner@example.com', PASSWORD, 'deadbeef')).toBeNull();
    expect(await authenticate('owner@example.com', PASSWORD, '10.0.0.1')).toBeNull();
  });

  it('shares its budget with the panel login: a guesser is locked out, even with the right password next', async () => {
    for (let i = 0; i < 3; i++) expect(await login('owner@example.com', `guess ${i}`)).toBeNull();
    expect(await login('owner@example.com')).toBeNull();
  });

  // A password is one factor; SFTP must not be a way around the second.
  it('refuses the password of an account with two-factor sign-in, or when it is required', async () => {
    await repo.setUserTotp('owner', { secret: 'JBSWY3DPEHPK3PXP', enabledAt: new Date().toISOString() });
    expect(await login('owner@example.com')).toBeNull();
    await repo.setUserTotp('owner', { secret: null, enabledAt: null });
    totpRequired = true;
    expect(await login('owner@example.com')).toBeNull();
  });

  it('accepts an API token as the password — read-only unless it has the write scope', async () => {
    await repo.setUserTotp('owner', { secret: 'JBSWY3DPEHPK3PXP', enabledAt: new Date().toISOString() });
    const ro = generateApiToken();
    await repo.createApiToken({ userId: 'owner', name: 'ro', tokenHash: ro.hash, scopes: '', expiresAt: null });
    const rw = generateApiToken();
    await repo.createApiToken({ userId: 'owner', name: 'rw', tokenHash: rw.hash, scopes: 'write', expiresAt: null });

    expect(await login('owner@example.com', ro.secret)).toMatchObject({ userId: 'owner', credentialAllowsWrite: false });
    expect(await login('owner@example.com', rw.secret)).toMatchObject({ userId: 'owner', credentialAllowsWrite: true });
  });

  it("refuses somebody's token under another account's name", async () => {
    const t = generateApiToken();
    await repo.createApiToken({ userId: 'stranger', name: 't', tokenHash: t.hash, scopes: 'write', expiresAt: null });
    expect(await login('owner@example.com', t.secret)).toBeNull();
  });

  describe('file operations', () => {
    let calls: Array<{ url: string; method: string; body?: string }>;
    let reply: (url: string) => Response | Promise<Response>;

    const filesFor = (identity: SftpIdentity) =>
      createAgentSftpFiles(
        {
          repo,
          agentUrlFor: async (nodeId) => `http://agent-${nodeId}:9100`,
          agentFetch: async (url, init) => {
            const body = init?.body;
            calls.push({ url, method: init?.method ?? 'GET', body: typeof body === 'string' ? body : body ? `<${(body as Uint8Array).length} bytes>` : undefined });
            return reply(url);
          },
        },
        identity
      );
    const owner: SftpIdentity = { userId: 'owner', email: 'owner@example.com', deploymentId: '', credentialAllowsWrite: true };

    beforeEach(() => {
      calls = [];
      owner.deploymentId = deploymentId;
      reply = () => new Response(JSON.stringify([{ name: 'world', kind: 'dir', size: 0 }]), { status: 200 });
    });

    it("goes to the owning node's agent, for the server's container", async () => {
      const files = filesFor(owner);
      expect(await files.list('/data')).toEqual([{ name: 'world', kind: 'dir', size: 0 }]);
      await files.write('/data/a b.txt', Buffer.from('hi'));
      await files.rename('/data/x', '/data/y');
      expect(calls).toEqual([
        { url: 'http://agent-node-1:9100/files/c1?path=%2Fdata', method: 'GET', body: undefined },
        { url: 'http://agent-node-1:9100/files/c1/binary?path=%2Fdata%2Fa%20b.txt', method: 'PUT', body: '<2 bytes>' },
        { url: 'http://agent-node-1:9100/files/c1/rename', method: 'POST', body: '{"from":"/data/x","to":"/data/y"}' },
      ]);
    });

    it("maps the agent's answers onto SFTP's: missing, failed, unreachable", async () => {
      const files = filesFor(owner);
      reply = () => new Response(JSON.stringify({ error: 'no such file: /x' }), { status: 404 });
      await expect(files.read('/x')).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
      reply = () => new Response(JSON.stringify({ error: 'ls: /x: No such file or directory' }), { status: 400 });
      await expect(files.list('/x')).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
      reply = () => new Response(JSON.stringify({ error: 'that path is a directory' }), { status: 400 });
      await expect(files.read('/data')).rejects.toMatchObject({ code: 'FAILURE', message: 'that path is a directory' });
      reply = () => {
        throw new TypeError('fetch failed');
      };
      await expect(files.list('/')).rejects.toMatchObject({ code: 'FAILURE', message: /cannot be reached/ });
    });

    it('lets an operator read but not change anything', async () => {
      const files = filesFor({ userId: 'op', email: 'op@example.com', deploymentId, credentialAllowsWrite: true });
      await files.list('/');
      await expect(files.assertWritable()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: /role/ });
      await expect(files.write('/a', Buffer.from('x'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(files.remove('/a')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(calls.map((c) => c.method)).toEqual(['GET']);
    });

    it('holds a read-only token to reading, even for the owner', async () => {
      const files = filesFor({ ...owner, credentialAllowsWrite: false });
      await expect(files.mkdir('/new')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: /read-only/ });
      expect(calls).toEqual([]);
    });

    it('ends access in an open session when the share is revoked', async () => {
      const files = filesFor({ userId: 'op', email: 'op@example.com', deploymentId, credentialAllowsWrite: true });
      await files.list('/');
      const share = await repo.getSubuserFor(deploymentId, 'op@example.com');
      await repo.deleteSubuser(share!.id);
      await expect(files.list('/')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(calls).toHaveLength(1);
    });

    it('says the server must be running, rather than calling a container that is gone', async () => {
      await repo.updateDeploymentStatus(deploymentId, { status: 'stopped', containerId: null });
      await expect(filesFor(owner).list('/')).rejects.toMatchObject({ code: 'FAILURE', message: /not running/ });
      expect(calls).toEqual([]);
    });
  });
});

describe('loadOrCreateHostKey', () => {
  it('creates a key readable only by its owner, and returns the same one on the next start', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sftp-key-')), 'nested', 'host_key');
    const first = loadOrCreateHostKey(path);
    expect(first).toContain('PRIVATE KEY');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateHostKey(path)).toBe(first);
    expect(readFileSync(path, 'utf8')).toBe(first);
  });
});
