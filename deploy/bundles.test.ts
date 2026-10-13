// The release bundles, checked against the two grammars they have to satisfy.
//
// For most people the bundle *is* the product: they never clone this repo, they
// download an archive and run `docker compose up`. Nothing tested that until
// both editions shipped unable to start (#291, #292), so these assertions are
// deliberately about the failures we actually had rather than about YAML in
// general.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEPLOY = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DEPLOY, '..');

const COMPOSE_FILES = [
  join(ROOT, 'docker-compose.yml'),
  join(DEPLOY, 'community', 'docker-compose.yml'),
  join(DEPLOY, 'hosted', 'docker-compose.yml'),
];

/** Docker's own rule for a container name. An image reference is not this. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function containerNamesIn(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/^\s*container_name:\s*(\S+)/gm)].map((m) => m[1]);
}

describe('the release bundles', () => {
  it.each(COMPOSE_FILES)('gives every service a Docker-valid container name: %s', (file) => {
    // #291: the bundles borrowed the slash from the nested *image* repository
    // (#200), which is valid there and invalid here. Every service but rabbitmq
    // failed to create, so the stack never came up at all.
    const names = containerNamesIn(file);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(CONTAINER_NAME);
  });

  it.each(COMPOSE_FILES)('names each container once: %s', (file) => {
    const names = containerNamesIn(file);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ships a billing-bridge in the hosted bundle and not in the community one', () => {
    const hosted = readFileSync(join(DEPLOY, 'hosted', 'docker-compose.yml'), 'utf8');
    const community = readFileSync(join(DEPLOY, 'community', 'docker-compose.yml'), 'utf8');
    expect(hosted).toContain('billing-bridge');
    expect(community).not.toContain('billing-bridge');
  });
});

describe('service images', () => {
  // Every Dockerfile's final stage, so the ENV check below looks at what the
  // image actually runs with rather than what the builder saw.
  function runtimeStage(file: string): string {
    const text = readFileSync(file, 'utf8');
    const stages = text.split(/^FROM /m);
    return stages[stages.length - 1];
  }

  const dockerfiles = readdirSync(join(ROOT, 'services'))
    .map((service) => join(ROOT, 'services', service, 'Dockerfile'))
    .concat(join(ROOT, 'dashboard', 'Dockerfile'), join(ROOT, 'allinone', 'Dockerfile'));

  it.each(dockerfiles)('stamps its edition instead of baking NEXUS_EDITION in: %s', (file) => {
    // #292: billing-bridge set `ENV NEXUS_EDITION=community` in its runtime
    // stage. In the hosted image that contradicted the stamp, so the guard in
    // shared/src/edition.ts stopped it on every start — and hosted is the only
    // edition that service is built for. The stamp is the single source; a
    // baked-in variable can only ever disagree with it.
    const stage = runtimeStage(file);
    expect(stage).toContain('/etc/nexusinfra/edition');
    expect(stage).not.toMatch(/^ENV NEXUS_EDITION/m);
  });
});

describe('node agent backups survive the container (#357)', () => {
  // The agent writes backups to BACKUP_DIR. The bundles mounted a volume at a
  // path nothing pointed BACKUP_DIR at, so backups lived in the container and
  // every upgrade (a recreate) deleted them while the panel still listed them.
  const agentStage = runtimeStage(join(ROOT, 'services', 'node-agent', 'Dockerfile'));
  const backupDir = /^ENV BACKUP_DIR=(\S+)$/m.exec(agentStage)?.[1];

  function runtimeStage(file: string): string {
    const stages = readFileSync(file, 'utf8').split(/^FROM /m);
    return stages[stages.length - 1];
  }

  /** One service's block in a compose file: from its key to the next service key. */
  function serviceBlock(file: string, name: string): string {
    const text = readFileSync(file, 'utf8');
    const start = text.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
    if (start < 0) return '';
    const rest = text.slice(start + 1);
    const next = rest.search(/^ {2}[a-z][\w-]*:\s*$|^\S/m);
    return next < 0 ? rest : rest.slice(0, next);
  }

  it('the image keeps backups in a declared volume by default', () => {
    expect(backupDir).toBeTruthy();
    expect(backupDir!.startsWith('/tmp')).toBe(false);
    expect(agentStage).toContain(`VOLUME ${backupDir}`);
  });

  it.each(COMPOSE_FILES)('mounts a named volume at the image\'s BACKUP_DIR: %s', (file) => {
    const block = serviceBlock(file, 'node-agent');
    expect(block).not.toBe('');
    expect(block).toMatch(new RegExp(`- [a-z_]+:${backupDir!.replace(/\//g, '\\/')}\\s*$`, 'm'));
  });

  it('documents a standalone agent that restarts, is reachable, and keeps its backups', () => {
    const images = readFileSync(join(ROOT, 'docs', 'images.md'), 'utf8');
    const run = /docker run -d --name nexusinfra-node-agent[\s\S]*?node-agent:\S+/.exec(images)?.[0] ?? '';
    expect(run).toContain('--restart unless-stopped');
    expect(run).toContain('-p 9100:9100');
    expect(run).toContain(`:${backupDir}`);
  });
});
