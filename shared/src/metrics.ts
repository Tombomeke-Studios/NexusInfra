import { timingSafeEqual } from 'crypto';

// Prometheus metrics for every service (#246) — the conventional, cheap half of
// "Metrics: InfluxDB + Grafana". A dependency-free registry and the text
// exposition format (0.0.4), so any scraper can read it and no service carries
// a client library for three metric types.

type Labels = Record<string, string>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelText(labels: Labels): string {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${escape(String(v))}"`).join(',')}}` : '';
}

function key(labels: Labels): string {
  return JSON.stringify(Object.entries(labels));
}

function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(Math.round(n * 1e9) / 1e9);
}

interface Metric {
  name: string;
  render(): string[] | Promise<string[]>;
}

export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    private readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    const current = this.values.get(k);
    if (current) current.value += by;
    else this.values.set(k, { labels, value: by });
  }

  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values.values()].map((v) => `${this.name}${labelText(v.labels)} ${formatNumber(v.value)}`)];
  }
}

export class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    private readonly help: string,
    private readonly buckets: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s!.counts[i]++;
    });
    s.sum += value;
    s.count++;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${labelText({ ...s.labels, le: formatNumber(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${labelText({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${labelText(s.labels)} ${formatNumber(s.sum)}`);
      lines.push(`${this.name}_count${labelText(s.labels)} ${s.count}`);
    }
    return lines;
  }
}

export type GaugeSample = { labels?: Labels; value: number };

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];
  private readonly names = new Set<string>();
  private readonly errors = new Counter('nexusinfra_metric_errors_total', 'Gauges that failed to read at scrape time.');

  private claim(name: string): void {
    if (!NAME.test(name)) throw new Error(`invalid metric name ${name}`);
    if (this.names.has(name)) throw new Error(`metric ${name} is already registered`);
    this.names.add(name);
  }

  counter(name: string, help: string, _labelNames: string[] = []): Counter {
    this.claim(name);
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }

  histogram(name: string, help: string, _labelNames: string[] = [], buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]): Histogram {
    this.claim(name);
    const h = new Histogram(name, help, [...buckets].sort((a, b) => a - b));
    this.metrics.push(h);
    return h;
  }

  /**
   * A value read when scraped rather than kept up to date — deployments by
   * status, outbox depth. A gauge that fails to read is left out of that scrape
   * and counted, so one broken source never blanks the whole endpoint.
   */
  gauge(name: string, help: string, _labelNames: string[], read: () => GaugeSample[] | number | Promise<GaugeSample[] | number>): void {
    this.claim(name);
    this.metrics.push({
      name,
      render: async () => {
        const got = await read();
        const samples = typeof got === 'number' ? [{ value: got }] : got;
        return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples.map((s) => `${name}${labelText(s.labels ?? {})} ${formatNumber(s.value)}`)];
      },
    });
  }

  /** Synchronous metrics only — counters and histograms. */
  render(): string {
    const lines: string[] = [];
    for (const m of this.metrics) {
      const out = m.render();
      if (!(out instanceof Promise)) lines.push(...out);
    }
    return lines.join('\n') + '\n';
  }

  async renderAsync(): Promise<string> {
    const lines: string[] = [];
    for (const m of this.metrics) {
      try {
        lines.push(...(await m.render()));
      } catch {
        this.errors.inc({ metric: m.name });
      }
    }
    lines.push(...this.errors.render());
    return lines.join('\n') + '\n';
  }
}

function processLines(): string[] {
  const mem = process.memoryUsage();
  return [
    '# HELP process_resident_memory_bytes Resident memory size in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${mem.rss}`,
    '# HELP nodejs_heap_used_bytes V8 heap in use, in bytes.',
    '# TYPE nodejs_heap_used_bytes gauge',
    `nodejs_heap_used_bytes ${mem.heapUsed}`,
    '# HELP process_uptime_seconds Seconds since the process started.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${Math.round(process.uptime())}`,
  ];
}

/**
 * Request counts and durations, labelled by the **matched route pattern** —
 * `/deployments/:id`, never `/deployments/3f2a…`. The raw path would give each
 * server its own series and bury the scraper; a request no route matched is
 * labelled `unmatched`.
 */
export function httpMetrics(registry: MetricsRegistry, service: string) {
  const requests = registry.counter('nexusinfra_http_requests_total', 'HTTP requests handled, by route pattern and status class.');
  const duration = registry.histogram('nexusinfra_http_request_duration_seconds', 'HTTP request duration, by route pattern.');
  return (
    req: { method: string; route?: { path?: string }; baseUrl?: string; originalUrl?: string },
    res: { statusCode: number; on(event: 'finish', fn: () => void): unknown },
    next: () => void,
  ): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      const labels = { service, method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` };
      requests.inc(labels);
      duration.observe({ service, method: req.method, route }, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  };
}

/** Constant-time check of an optional bearer token; no token configured means open. */
export function tokenAllows(token: string | undefined, authorization: string | undefined): boolean {
  if (!token) return true;
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `GET /metrics`. Open unless `METRICS_TOKEN` is set — the numbers are
 * aggregates with no names or ids in them, but on a port the internet can
 * reach, set the token and give it to the scraper.
 */
export function metricsHandler(registry: MetricsRegistry, opts: { token?: string } = { token: process.env.METRICS_TOKEN }) {
  return async (
    req: { headers: Record<string, string | string[] | undefined> },
    res: { status(code: number): unknown; setHeader(k: string, v: string): unknown; send(body: string): unknown; end(): unknown },
  ): Promise<void> => {
    const auth = req.headers.authorization;
    if (!tokenAllows(opts.token, Array.isArray(auth) ? auth[0] : auth)) {
      res.status(401);
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send((await registry.renderAsync()) + processLines().join('\n') + '\n');
  };
}

/** `nexusinfra_build_info{service,version,edition} 1` — which build is answering. */
export function registerBuildInfo(registry: MetricsRegistry, service: string, info: { version: string; edition: string }): void {
  registry.gauge('nexusinfra_build_info', 'The build this service is running.', ['service', 'version', 'edition'], () => [
    { labels: { service, version: info.version, edition: info.edition }, value: 1 },
  ]);
}
