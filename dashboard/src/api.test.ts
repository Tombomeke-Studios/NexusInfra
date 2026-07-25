import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createDeployment, listDeployments, login, streamLogs, streamStats, listFiles, writeFile, createDatabase, createBackup, createSchedule, registerNode, execCommand, inviteSubuser, ApiError, TOKEN_KEY, type ContainerStats } from './api';

// The client is verified against a mocked fetch: it attaches the Bearer token,
// posts JSON, and surfaces API errors with their status.

describe('api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => body,
    } as Response;
  }

  it('attaches the Bearer token from storage', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-123');
    fetchMock.mockResolvedValue(jsonResponse([]));

    await listDeployments();

    const [, options] = fetchMock.mock.calls[0];
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('omits the auth header when no token is stored', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: 't' }));
    await login('dev', 'dev');

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/auth/login');
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('posts the deployment body as JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'd1' }, 201));
    await createDeployment({ name: 'svc', dockerImage: 'nginx', ports: { '8080': '80' } });

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual({
      name: 'svc',
      dockerImage: 'nginx',
      ports: { '8080': '80' },
    });
  });

  it('parses SSE data lines from the log stream', async () => {
    const chunks = ['data: first line\n\ndata: second', ' line\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);

    const lines: string[] = [];
    await streamLogs('d1', (l) => lines.push(l), new AbortController().signal);
    expect(lines).toEqual(['first line', 'second line']);
  });

  it('lists files with the path query and writes via PUT', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ name: 'src', kind: 'dir', size: 0 }]));
    const entries = await listFiles('d1', '/app');
    expect(entries).toEqual([{ name: 'src', kind: 'dir', size: 0 }]);
    expect(fetchMock.mock.calls[0][0]).toContain('/deployments/d1/files?path=%2Fapp');

    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) } as Response);
    await writeFile('d1', '/app/x.txt', 'hello');
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toContain('/deployments/d1/files/content');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body as string)).toEqual({ path: '/app/x.txt', content: 'hello' });
  });

  it('creates a database with the engine in the POST body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'db1', engine: 'postgres' }, 201));
    await createDatabase('d1', 'postgres');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/deployments/d1/databases');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ engine: 'postgres' });
  });

  it('creates a backup with a POST to the deployment', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'bk1', name: 'backup-x', sizeBytes: 2048 }, 201));
    await createBackup('d1');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/deployments/d1/backups');
    expect(options.method).toBe('POST');
  });

  it('invites a subuser with email/role in the POST body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's1', email: 'a@b.com', role: 'viewer' }, 201));
    await inviteSubuser('d1', 'a@b.com', 'viewer');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/deployments/d1/subusers');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ email: 'a@b.com', role: 'viewer' });
  });

  it('runs a console command with the command in the POST body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ stdout: 'ok', stderr: '', exitCode: 0 }, 200));
    const r = await execCommand('d1', 'ls -la');
    expect(r.stdout).toBe('ok');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/deployments/d1/exec');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ command: 'ls -la' });
  });

  it('registers a node with name/location in the POST body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'node-abc', name: 'Home box' }, 201));
    await registerNode({ name: 'Home box', location: 'home-server' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/nodes');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Home box', location: 'home-server' });
  });

  it('creates a schedule with the cron/action in the POST body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 's1' }, 201));
    await createSchedule('d1', { name: 'Nightly', cron: '0 4 * * *', action: 'backup' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/deployments/d1/schedules');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'Nightly', cron: '0 4 * * *', action: 'backup' });
  });

  it('parses JSON stats samples from the stats stream', async () => {
    const sample = { cpuPercent: 12.5, memUsedMb: 200, memLimitMb: 1024, memPercent: 19.5, rxKb: 3, txKb: 1 };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(sample)}\n\n`));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);

    const samples: ContainerStats[] = [];
    await streamStats('d1', (st) => samples.push(st), new AbortController().signal);
    expect(samples).toEqual([sample]);
  });

  it('throws ApiError carrying the status and message on failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'No healthy node available' }, 503));
    await expect(createDeployment({ name: 'x', dockerImage: 'nginx' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'No healthy node available',
    });
    expect(ApiError).toBeDefined();
  });
});
