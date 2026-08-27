// The release bundles, checked against the two grammars they have to satisfy.
//
// For most people the bundle *is* the product: they never clone this repo, they
// download an archive and run `docker compose up`. Nothing tested that until
// both editions shipped unable to start (#291, #292), so these assertions are
// deliberately about the failures we actually had rather than about YAML in
// general.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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
