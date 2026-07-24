import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createDeployment, listDeployments, login, streamLogs, ApiError, TOKEN_KEY } from './api';

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
