import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import ssh2 from 'ssh2';
import { can } from './access.js';
import { resolveAccess } from './accessGuard.js';
import { authenticateApiToken } from './auth.js';
import { isApiTokenSecret, scopeAllowsMethod } from './apiTokens.js';
import { loginKeys, type LoginLimiter } from './loginLimiter.js';
import { isPlatformRole, type UserService } from './users.js';
import { parseSftpUsername, SftpError, type SftpEntry, type SftpFiles, type SftpIdentity } from './sftp.js';
import type { DeploymentView, Repository } from './types.js';

// The half of SFTP (#235) that knows about accounts, servers and nodes: who a
// login is, and how a file operation reaches the agent that owns the server.

// ── Who is logging in ──────────────────────────────────────────────────────────

export interface SftpAuthDeps {
  repo: Repository;
  users: Pick<UserService, 'authenticate'>;
  limiter: LoginLimiter;
  totpRequired: () => boolean;
}

/** The server a login names: its full id, or an unambiguous prefix of eight or more characters. */
export function findServer(deployments: Pick<DeploymentView, 'id'>[], server: string): string | null {
  const exact = deployments.find((d) => d.id === server);
  if (exact) return exact.id;
  if (server.length < 8) return null;
  const matches = deployments.filter((d) => d.id.startsWith(server));
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Resolve an SFTP login into a session identity, or null.
 *
 * Every refusal is the same null — wrong password, unknown server, no access —
 * for the same reason the panel's login answers one 401: anything more specific
 * tells a stranger which of their guesses was right.
 */
export function createSftpAuthenticator(deps: SftpAuthDeps) {
  const { repo, users, limiter } = deps;

  /** The account behind a password or an API token, and whether it may write. */
  async function credential(email: string, secret: string): Promise<{ id: string; email: string; platformRole: string; allowsWrite: boolean } | null> {
    if (isApiTokenSecret(secret)) {
      const principal = await authenticateApiToken(repo, secret);
      if (!principal) return null;
      const user = await repo.getUser(principal.id);
      // The token has to belong to the account the login names: a token is not a
      // way to become somebody else's user name.
      if (!user || user.email.toLowerCase() !== email) return null;
      return { id: user.id, email: user.email, platformRole: principal.platformRole, allowsWrite: scopeAllowsMethod(principal.scopes ?? [], 'PUT') };
    }

    const user = await users.authenticate(email, secret);
    if (!user) return null;
    // A password is one factor. An account that has a second one — or is required
    // to — does not get to skip it by speaking SFTP; it uses an API token, which it
    // could only have minted from a session that passed the second factor.
    if (user.totpEnabledAt || deps.totpRequired()) return null;
    return { id: user.id, email: user.email, platformRole: user.platformRole, allowsWrite: true };
  }

  return async function authenticate(username: string, password: string, ip: string): Promise<SftpIdentity | null> {
    const parsed = parseSftpUsername(username);
    if (!parsed || !password) return null;

    // The same limiter as the panel's login: an SFTP port is a password prompt too,
    // and a separate budget would double what a guesser gets.
    const keys = loginKeys(ip, parsed.email);
    if (!limiter.check(keys).allowed) return null;

    const who = await credential(parsed.email, password);
    const deploymentId = who ? findServer(await repo.listDeployments(), parsed.server) : null;
    const access =
      who && deploymentId
        ? await resolveAccess(repo, { id: who.id, platformRole: isPlatformRole(who.platformRole) ? who.platformRole : 'user' }, deploymentId)
        : null;
    if (!who || !deploymentId || !access || !can(access.role, 'file.read')) {
      limiter.fail(keys);
      return null;
    }

    limiter.succeed(keys);
    return { userId: who.id, email: who.email, deploymentId, credentialAllowsWrite: who.allowsWrite };
  };
}

// ── Where the bytes go ─────────────────────────────────────────────────────────

export interface SftpFilesDeps {
  repo: Repository;
  agentUrlFor(nodeId: string | null): Promise<string>;
  agentFetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * One session's file operations, against the agent that owns the server.
 *
 * Access and the container are resolved again on every operation, not once at
 * login: a share revoked, a role lowered, a server stopped or moved to another
 * node all take effect in a session that is already open.
 */
export function createAgentSftpFiles(deps: SftpFilesDeps, identity: SftpIdentity): SftpFiles {
  const { repo } = deps;

  async function target(permission: 'file.read' | 'file.write'): Promise<string> {
    const user = await repo.getUser(identity.userId);
    const access = user
      ? await resolveAccess(repo, { id: user.id, platformRole: isPlatformRole(user.platformRole) ? user.platformRole : 'user' }, identity.deploymentId)
      : null;
    if (!access || !can(access.role, 'file.read')) throw new SftpError('PERMISSION_DENIED', 'you no longer have access to this server');
    if (permission === 'file.write' && (!can(access.role, 'file.write') || !identity.credentialAllowsWrite)) {
      throw new SftpError(
        'PERMISSION_DENIED',
        identity.credentialAllowsWrite ? 'your role on this server cannot change files' : 'this API token is read-only; use one with the write scope'
      );
    }
    const detail = access.deployment;
    if (detail.status !== 'running' || !detail.containerId) {
      // Files are reached through the running container, as they are in the Files tab.
      throw new SftpError('FAILURE', 'the server is not running; start it to reach its files');
    }
    return `${await deps.agentUrlFor(detail.nodeId)}/files/${encodeURIComponent(detail.containerId)}`;
  }

  const q = (v: string) => encodeURIComponent(v);

  async function call(url: string, init?: RequestInit): Promise<Response> {
    let r: Response;
    try {
      r = await deps.agentFetch(url, init);
    } catch {
      throw new SftpError('FAILURE', 'the node this server runs on cannot be reached');
    }
    if (r.ok) return r;
    const message = await r
      .json()
      .then((b: { error?: string }) => b.error ?? `HTTP ${r.status}`)
      .catch(() => `HTTP ${r.status}`);
    if (r.status === 404 || /no such file/i.test(message)) throw new SftpError('NO_SUCH_FILE', message);
    throw new SftpError('FAILURE', message);
  }

  return {
    async assertWritable() {
      await target('file.write');
    },
    async list(dir) {
      const r = await call(`${await target('file.read')}?path=${q(dir)}`);
      return (await r.json()) as SftpEntry[];
    },
    async read(path) {
      const r = await call(`${await target('file.read')}/binary?path=${q(path)}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async write(path, data) {
      await call(`${await target('file.write')}/binary?path=${q(path)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(data),
      });
    },
    async mkdir(path) {
      await call(`${await target('file.write')}/dir`, json('POST', { path }));
    },
    async rename(from, to) {
      await call(`${await target('file.write')}/rename`, json('POST', { from, to }));
    },
    async remove(path) {
      await call(`${await target('file.write')}?path=${q(path)}`, { method: 'DELETE' });
    },
  };
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ── The server's own key ───────────────────────────────────────────────────────

/**
 * The SFTP host key: read from `path`, or generated there on first start.
 *
 * It must survive restarts and upgrades — a client that sees the key change
 * warns about a man in the middle, and after the first false alarm people learn
 * to click through the real one. So it lives on the data volume, beside the
 * database, and is written readable by its owner only.
 */
export function loadOrCreateHostKey(path: string): string {
  if (existsSync(path)) return readFileSync(path, 'utf8');
  const { private: key } = ssh2.utils.generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}
