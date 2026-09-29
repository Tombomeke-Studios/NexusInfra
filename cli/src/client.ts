// A thin client for the panel's HTTP API (#240) — the same routes the panel
// uses, authenticated with an API token (#228) instead of a login.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class Client {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError(0, `cannot reach ${this.baseUrl}: ${err instanceof Error ? err.message : err}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON — an HTML error page from a proxy, say; the status still speaks.
    }
    if (!res.ok) {
      const message = (parsed as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
      throw new ApiError(res.status, message);
    }
    return parsed as T;
  }

  /** A binary download — a backup tar. */
  async download(path: string): Promise<{ bytes: Uint8Array; filename: string | null }> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), filename };
  }

  /** Follow a server-sent-event stream, one `data:` line at a time, until it ends or `signal` aborts. */
  async stream(path: string, onData: (data: string) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, { headers: this.headers(), signal });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('data: ')) onData(line.slice(6));
    }
  }
}
