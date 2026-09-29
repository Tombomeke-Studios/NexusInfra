import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, stat } from 'fs/promises';
import { Client } from './client.js';
import { run, type CliDeps } from './commands.js';
import { resolveConfig, writeConfigFile, readConfigFile } from './config.js';
import { table } from './format.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const SERVERS = [
  { id: ID_A, name: 'survival', status: 'running', dockerImage: 'itzg/minecraft-server', nodeId: 'node-a', createdAt: new Date().toISOString() },
  { id: ID_B, name: 'web', status: 'stopped', dockerImage: 'nginx', nodeId: 'node-a', createdAt: new Date().toISOString() },
];

describe('nexusctl (#240)', () => {
  let out: string;
  let err: string;
  let calls: Array<{ method: string; url: string; body?: unknown; auth: string | null }>;
  let written: Record<string, Uint8Array>;
  let saved: unknown;
  let routes: (method: string, url: string, body?: unknown) => Response;

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get('authorization') });
    return routes(method, url, body);
  }) as typeof fetch;

  const deps = (env: Record<string, string> = { NEXUSCTL_URL: 'https://panel.test', NEXUSCTL_TOKEN: 'nxi_tok' }): CliDeps => ({
    out: (t) => void (out += t),
    err: (t) => void (err += t),
    env,
    configFile: '/cfg/config.json',
    readConfig: async () => ({}),
    writeConfig: async (c) => void (saved = c),
    makeClient: (url, token) => new Client(url, token, fakeFetch),
    writeFile: async (p, b) => void (written[p] = b),
  });

  beforeEach(() => {
    out = '';
    err = '';
    calls = [];
    written = {};
    saved = undefined;
    routes = (method, url) => {
      if (url.includes('/deployments?')) {
        const q = new URL(url).searchParams.get('q');
        const items = q ? SERVERS.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())) : SERVERS;
        return json({ items, total: items.length, limit: 200, offset: 0 });
      }
      if (url.endsWith('/me')) return json({ email: 'ada@example.com', displayName: 'Ada', platformRole: 'user' });
      return json({ error: `unrouted ${method} ${url}` }, 404);
    };
  });

  it('lists servers as a table, and as JSON for scripts', async () => {
    expect(await run(['servers', 'list'], deps())).toBe(0);
    expect(out).toMatch(/^ID\s+NAME\s+STATUS/);
    expect(out).toContain('survival');
    expect(calls[0].auth).toBe('Bearer nxi_tok');

    out = '';
    await run(['servers', 'list', '--json'], deps());
    expect(JSON.parse(out).map((s: { name: string }) => s.name)).toEqual(['survival', 'web']);
  });

  it('acts on servers by name through the bulk endpoint, and exits non-zero on a partial failure', async () => {
    routes = ((orig) => (method: string, url: string, body?: unknown) =>
      url.endsWith('/deployments/bulk')
        ? json({ succeeded: 1, failed: 1, results: [{ id: ID_A, name: 'survival', ok: true }, { id: ID_B, name: 'web', ok: false, error: 'deployment is not running' }] })
        : orig(method, url, body))(routes);

    const code = await run(['servers', 'stop', 'survival', 'web'], deps());
    expect(code).toBe(1);
    const bulk = calls.find((c) => c.url.endsWith('/deployments/bulk'));
    expect(bulk?.body).toEqual({ action: 'stop', ids: [ID_A, ID_B] });
    expect(out).toContain('failed web — deployment is not running');
  });

  it('refuses a name that matches several servers, listing their ids', async () => {
    routes = () => json({ items: [{ ...SERVERS[0] }, { ...SERVERS[0], id: ID_B }], total: 2 });
    expect(await run(['servers', 'show', 'survival'], deps())).toBe(1);
    expect(err).toContain('several servers are named "survival"');
    expect(err).toContain(ID_B);
  });

  it('creates from an image with ports, env and persistent directories', async () => {
    routes = ((orig) => (method: string, url: string, body?: unknown) =>
      method === 'POST' && url.endsWith('/deployments') ? json({ ...SERVERS[1], name: 'site' }, 201) : orig(method, url, body))(routes);
    const code = await run(['servers', 'create', '--name', 'site', '--image', 'nginx', '--port', '8080:80', '--env', 'A=1', '--persist', '/usr/share/nginx/html'], deps());
    expect(code).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ name: 'site', ports: { '8080': '80' }, persistPaths: ['/usr/share/nginx/html'], dockerImage: 'nginx', env: { A: '1' }, type: 'app' });
  });

  it('creates from an egg with its variables', async () => {
    routes = ((orig) => (method: string, url: string, body?: unknown) =>
      method === 'POST' && url.endsWith('/deployments') ? json(SERVERS[0], 201) : orig(method, url, body))(routes);
    await run(['servers', 'create', '--name', 'mc', '--egg', 'minecraft-java', '--var', 'TYPE=PAPER'], deps());
    expect(calls.at(-1)?.body).toMatchObject({ eggId: 'minecraft-java', eggValues: { TYPE: 'PAPER' } });
  });

  it('says what is wrong with a malformed request instead of sending it', async () => {
    expect(await run(['servers', 'create', '--name', 'x'], deps())).toBe(2);
    expect(await run(['servers', 'create', '--name', 'x', '--image', 'nginx', '--port', '8080'], deps())).toBe(2);
    expect(err).toContain('HOST:CONTAINER');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('will not delete without --yes', async () => {
    expect(await run(['servers', 'delete', 'web'], deps())).toBe(2);
    expect(err).toContain('--yes');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('downloads a backup under the name the panel gives it', async () => {
    routes = ((orig) => (method: string, url: string, body?: unknown) =>
      url.endsWith('/download')
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-disposition': 'attachment; filename="survival-backup-1.tar"' } })
        : orig(method, url, body))(routes);
    expect(await run(['backups', 'download', 'survival', 'b1'], deps())).toBe(0);
    expect([...written['survival-backup-1.tar']]).toEqual([1, 2, 3]);
  });

  it('checks a token before saving it', async () => {
    expect(await run(['login', '--url', 'https://panel.test/', '--token', 'nxi_new'], deps({}))).toBe(0);
    expect(saved).toEqual({ url: 'https://panel.test', token: 'nxi_new' });

    routes = () => json({ error: 'invalid or expired token' }, 401);
    saved = undefined;
    expect(await run(['login', '--url', 'https://panel.test', '--token', 'nxi_bad'], deps({}))).toBe(1);
    expect(saved).toBeUndefined();
    expect(err).toContain('nexusctl login');
  });

  it('says how to sign in when it has nowhere to go', async () => {
    expect(await run(['servers', 'list'], deps({}))).toBe(2);
    expect(err).toContain('nexusctl login');
  });

  it('prints usage for help and an unknown command', async () => {
    expect(await run(['--help'], deps())).toBe(0);
    expect(out).toContain('nexusctl servers list');
    expect(await run(['frobnicate'], deps())).toBe(2);
  });
});

describe('config', () => {
  it('lets the environment win over the file', () => {
    expect(resolveConfig({ NEXUSCTL_URL: 'https://a/' }, { url: 'https://b', token: 't' })).toEqual({ url: 'https://a', token: 't' });
  });

  it('writes the token readable by its owner only', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nexusctl-'));
    const file = path.join(dir, 'sub', 'config.json');
    await writeConfigFile(file, { url: 'https://p', token: 'nxi_x' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readConfigFile(file)).toEqual({ url: 'https://p', token: 'nxi_x' });
    expect(JSON.parse(await readFile(file, 'utf8')).token).toBe('nxi_x');
  });
});

describe('table', () => {
  it('pads columns and leaves no trailing spaces', () => {
    expect(table([{ a: 'x', b: 'yy' }, { a: 'longer', b: 'z' }], [{ key: 'a', title: 'a' }, { key: 'b', title: 'b' }])).toBe('A       B\nx       yy\nlonger  z\n');
  });
});
