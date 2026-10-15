// The monitoring bundle (#355), checked against the code it watches.
//
// A dashboard is a second description of the metrics, and it drifts quietly: a
// renamed metric does not break anything, the panel just says "No data" and
// people learn to ignore it. So every query here is held to the metrics the
// services actually register.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DEPLOY, '..');
const MONITORING = join(DEPLOY, 'monitoring');

interface Target {
  expr: string;
  datasource?: { uid?: string };
}
interface Panel {
  type: string;
  title: string;
  datasource?: { uid?: string };
  targets?: Target[];
}

const dashboard = JSON.parse(readFileSync(join(MONITORING, 'grafana/dashboards/nexusinfra.json'), 'utf8')) as { uid: string; panels: Panel[] };
const panels = dashboard.panels.filter((p) => p.type !== 'row');

/** Every non-test TypeScript source under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === 'generated') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Metric names the services register — a quoted `nexusinfra_…`, or a process metric written out in shared. */
const registered = new Set<string>();
for (const file of [...sources(join(ROOT, 'services')), ...sources(join(ROOT, 'shared', 'src'))]) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/'(nexusinfra_[a-z_]+)'/g)) registered.add(m[1]);
  for (const m of text.matchAll(/`((?:process|nodejs)_[a-z_]+) /g)) registered.add(m[1]);
}

/** The metric names a PromQL expression reads (histogram suffixes stripped). */
function metricsIn(expr: string): string[] {
  return [...expr.matchAll(/\b((?:nexusinfra|process|nodejs)_[a-z_]+)\b/g)].map((m) => m[1].replace(/_(bucket|sum|count)$/, ''));
}

describe('the Grafana dashboard (#355)', () => {
  it('finds the metrics the services register', () => {
    // Guards the scan itself: an empty set would make every check below vacuous.
    expect(registered).toContain('nexusinfra_deployments');
    expect(registered).toContain('process_resident_memory_bytes');
  });

  it.each(panels.map((p) => [p.title, p] as const))('queries only metrics a service exports: %s', (_title, panel) => {
    expect(panel.targets?.length).toBeGreaterThan(0);
    for (const target of panel.targets ?? []) {
      for (const metric of metricsIn(target.expr)) expect(registered, `${metric} in "${target.expr}"`).toContain(metric);
    }
  });

  it('reads from the provisioned datasource, by its fixed uid', () => {
    const uid = /^\s*uid:\s*(\S+)\s*$/m.exec(readFileSync(join(MONITORING, 'grafana/provisioning/datasources/prometheus.yml'), 'utf8'))?.[1];
    expect(uid).toBeTruthy();
    for (const panel of panels) {
      expect(panel.datasource?.uid).toBe(uid);
      for (const target of panel.targets ?? []) expect(target.datasource?.uid).toBe(uid);
    }
  });

  it('gives every panel a distinct title and id', () => {
    expect(new Set(panels.map((p) => p.title)).size).toBe(panels.length);
    expect(new Set(dashboard.panels.map((p) => (p as unknown as { id: number }).id)).size).toBe(dashboard.panels.length);
  });
});

describe('the Prometheus scrape config (#355)', () => {
  // Flat, hand-written YAML: one `- job_name:` per job, each with one
  // `authorization` and one target — read with patterns rather than a parser.
  const read = (file: string) => readFileSync(join(MONITORING, 'prometheus', file), 'utf8');
  const jobsIn = (text: string) => [...text.matchAll(/^\s*- job_name:\s*(\S+)/gm)].map((m) => m[1]);
  const base = read('prometheus.yml');
  const billing = read('billing-bridge.yml');

  it('scrapes every service, the billing bridge only from its own hosted-only file', () => {
    const services = readdirSync(join(ROOT, 'services')).sort();
    expect([...jobsIn(base), ...jobsIn(billing)].sort()).toEqual(services);
    expect(jobsIn(base)).not.toContain('billing-bridge');
  });

  it('sends METRICS_TOKEN to every job from the file the entrypoint writes', () => {
    for (const text of [base, billing]) {
      expect([...text.matchAll(/credentials_file:\s*(\S+?)\s*\}/g)].map((m) => m[1])).toEqual(jobsIn(text).map(() => '/tmp/metrics_token'));
    }
  });
});
