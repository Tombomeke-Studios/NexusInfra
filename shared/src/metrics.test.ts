import { describe, it, expect } from 'vitest';
import { MetricsRegistry, metricsHandler, httpMetrics, tokenAllows } from './metrics.js';

describe('MetricsRegistry (#246)', () => {
  it('renders counters in the Prometheus text format, labels escaped', () => {
    const r = new MetricsRegistry();
    const c = r.counter('nexusinfra_events_total', 'Events seen.', ['type']);
    c.inc({ type: 'server.started' });
    c.inc({ type: 'server.started' }, 2);
    c.inc({ type: 'weird"\\\nname' });
    expect(r.render()).toBe(
      [
        '# HELP nexusinfra_events_total Events seen.',
        '# TYPE nexusinfra_events_total counter',
        'nexusinfra_events_total{type="server.started"} 3',
        'nexusinfra_events_total{type="weird\\"\\\\\\nname"} 1',
        '',
      ].join('\n')
    );
  });

  it('reads gauges at scrape time, so they are never stale', async () => {
    const r = new MetricsRegistry();
    let n = 1;
    r.gauge('nexusinfra_things', 'Things.', ['state'], () => [
      { labels: { state: 'up' }, value: n },
      { labels: { state: 'down' }, value: 0 },
    ]);
    n = 5;
    const text = await r.renderAsync();
    expect(text).toContain('nexusinfra_things{state="up"} 5');
    expect(text).toContain('nexusinfra_things{state="down"} 0');
  });

  it('keeps a scrape alive when one gauge fails, and says which', async () => {
    const r = new MetricsRegistry();
    r.gauge('nexusinfra_broken', 'Broken.', [], () => {
      throw new Error('db down');
    });
    r.counter('nexusinfra_ok_total', 'Fine.').inc();
    const text = await r.renderAsync();
    expect(text).toContain('nexusinfra_ok_total 1');
    expect(text).toContain('nexusinfra_metric_errors_total{metric="nexusinfra_broken"} 1');
  });

  it('builds cumulative histogram buckets with sum and count', () => {
    const r = new MetricsRegistry();
    const h = r.histogram('nexusinfra_seconds', 'Durations.', ['route'], [0.1, 1]);
    h.observe({ route: '/x' }, 0.05);
    h.observe({ route: '/x' }, 0.5);
    h.observe({ route: '/x' }, 3);
    const text = r.render();
    expect(text).toContain('nexusinfra_seconds_bucket{route="/x",le="0.1"} 1');
    expect(text).toContain('nexusinfra_seconds_bucket{route="/x",le="1"} 2');
    expect(text).toContain('nexusinfra_seconds_bucket{route="/x",le="+Inf"} 3');
    expect(text).toContain('nexusinfra_seconds_sum{route="/x"} 3.55');
    expect(text).toContain('nexusinfra_seconds_count{route="/x"} 3');
  });

  it('refuses a metric name Prometheus would reject, and a name used twice', () => {
    const r = new MetricsRegistry();
    expect(() => r.counter('bad-name', 'x')).toThrow();
    r.counter('nexusinfra_once_total', 'x');
    expect(() => r.counter('nexusinfra_once_total', 'x')).toThrow();
  });
});

describe('httpMetrics', () => {
  function fakeReqRes(route: string | undefined, url: string, status: number) {
    const listeners: Record<string, () => void> = {};
    const req = { method: 'GET', originalUrl: url, route: route ? { path: route } : undefined, baseUrl: '' };
    const res = { statusCode: status, on: (ev: string, fn: () => void) => (listeners[ev] = fn) };
    return { req, res, finish: () => listeners.finish?.() };
  }

  it('labels by the matched route pattern, never the raw path — ids would explode the series', () => {
    const r = new MetricsRegistry();
    const mw = httpMetrics(r, 'orchestrator');
    for (const id of ['a', 'b', 'c']) {
      const { req, res, finish } = fakeReqRes('/deployments/:id', `/deployments/${id}`, 200);
      mw(req, res, () => undefined);
      finish();
    }
    const unmatched = fakeReqRes(undefined, '/nope/123', 404);
    mw(unmatched.req, unmatched.res, () => undefined);
    unmatched.finish();

    const text = r.render();
    expect(text).toContain('nexusinfra_http_requests_total{service="orchestrator",method="GET",route="/deployments/:id",status="2xx"} 3');
    expect(text).toContain('route="unmatched",status="4xx"} 1');
    expect(text).not.toContain('/deployments/a');
  });
});

describe('metrics endpoint', () => {
  it('is open without a token and closed without the right one when a token is set', () => {
    expect(tokenAllows(undefined, undefined)).toBe(true);
    expect(tokenAllows('s3cret', 'Bearer s3cret')).toBe(true);
    expect(tokenAllows('s3cret', 'Bearer nope')).toBe(false);
    expect(tokenAllows('s3cret', undefined)).toBe(false);
  });

  it('serves the text format', async () => {
    const r = new MetricsRegistry();
    r.counter('nexusinfra_x_total', 'x').inc();
    let sent = '';
    let type = '';
    const res = { status: () => res, setHeader: (_k: string, v: string) => (type = v), send: (b: string) => (sent = b), end: () => undefined };
    await metricsHandler(r, { token: undefined })({ headers: {} }, res);
    expect(type).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(sent).toContain('nexusinfra_x_total 1');
    expect(sent).toContain('process_resident_memory_bytes');
  });
});
