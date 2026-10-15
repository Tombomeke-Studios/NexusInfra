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

  // #391: compose passes only what it lists. Every variable below was added
  // after the bundles were written and documented in docs/images.md, and none
  // reached its service — setting SMTP_URL in a bundle's .env did nothing.
  const FORWARDED: Record<string, string[]> = {
    orchestrator: ['SMTP_URL', 'SMTP_FROM', 'PANEL_URL', 'TRUST_PROXY', 'REQUIRE_TOTP', 'MAX_UPLOAD_BYTES'],
    'node-agent': [
      'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_ENDPOINT',
      'BACKUP_S3_REGION', 'BACKUP_S3_PREFIX', 'BACKUP_S3_PATH_STYLE', 'MAX_UPLOAD_BYTES',
    ],
  };
  it.each(COMPOSE_FILES)('forwards the optional settings from .env to the services that read them: %s', (file) => {
    const compose = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const [service, vars] of Object.entries(FORWARDED)) {
      const block = compose.match(new RegExp(`^ {2}${service}:\\n((?: {4}.*\\n|\\n)+)`, 'm'))?.[1];
      expect(block, `could not read the ${service} service block`).toBeTruthy();
      for (const name of vars) {
        expect(block, `${service} does not receive ${name}`).toMatch(new RegExp(`^\\s*- ${name}=\\$\\{${name}:-`, 'm'));
      }
    }
  });

  // #392: the bundles published control-room on 0.0.0.0:9000 — which nothing
  // outside needs, and which Portainer and MinIO already hold on a typical
  // self-hosting box, so `up` failed before the panel started — and the
  // orchestrator's API on every interface, against docs/deployment.md.
  it.each(COMPOSE_FILES.slice(1))('publishes only what is meant to be reached: %s', (file) => {
    const compose = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const block = (service: string) => compose.match(new RegExp(`^ {2}${service}:\\n((?: {4}.*\\n|\\n)+)`, 'm'))?.[1] ?? '';
    expect(block('control-room')).not.toMatch(/^\s*ports:/m);
    expect(block('node-agent')).not.toMatch(/^\s*ports:/m);
    expect(block('orchestrator')).toMatch(/'127\.0\.0\.1:\$\{ORCHESTRATOR_PORT:-9200\}:9200'/);
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

  // #372: the bridge serves only callers holding the internal token. A compose
  // file that gives the token to the Orchestrator and not to the bridge leaves
  // the bridge on the built-in default — every call answers 401 and billing is
  // quietly not enforced (the checks fail open).
  it.each(COMPOSE_FILES)('gives the billing bridge the internal token wherever it runs: %s', (file) => {
    // Line endings are the checkout's business; normalised so the match means the same everywhere.
    const compose = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (!/^ {2}billing-bridge:/m.test(compose)) return; // the community bundle has no billing bridge
    const service = compose.match(/^ {2}billing-bridge:\n((?: {4}.*\n|\n)+)/m)?.[1];
    expect(service, 'could not read the billing-bridge service block').toBeTruthy();
    expect(service).toMatch(/INTERNAL_API_TOKEN=/);
  });

  // #357: both bundles mounted a volume for the agent's backups and neither set
  // BACKUP_DIR, so nothing was ever written to it — backups lived in the
  // container and went with it on every upgrade. The image now names the
  // directory; a compose file has to mount a named volume exactly there.
  it.each(COMPOSE_FILES)('keeps the node agent’s backups on a named volume, where the image writes them: %s', (file) => {
    const dockerfile = readFileSync(join(ROOT, 'services', 'node-agent', 'Dockerfile'), 'utf8');
    const backupDir = dockerfile.match(/^ENV BACKUP_DIR=(\S+)/m)?.[1];
    expect(backupDir, 'the node-agent image must set BACKUP_DIR').toBeTruthy();
    expect(dockerfile).toContain(`VOLUME ["${backupDir}"]`);

    const compose = readFileSync(file, 'utf8');
    const mount = compose.match(new RegExp(`^\\s*-\\s*([a-z_]+):${backupDir}\\s*$`, 'm'));
    expect(mount, `no named volume mounted at ${backupDir}`).toBeTruthy();
    expect(compose).toMatch(new RegExp(`^  ${mount![1]}:`, 'm'));
    // Overriding the directory in a compose file would point the agent away from the mount again.
    expect(compose).not.toMatch(/BACKUP_DIR=/);
  });

  // #382: the agent asks game servers for their status on their published host
  // port. Inside the agent's container 127.0.0.1 is the container itself, so on
  // Linux every server would read "offline" without this mapping — and nothing
  // else would fail to say why.
  it.each(COMPOSE_FILES)('lets the node agent reach the host’s published ports: %s', (file) => {
    const compose = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const service = compose.match(/^ {2}node-agent:\n((?: {4}.*\n|\n)+)/m)?.[1];
    expect(service, 'could not read the node-agent service block').toBeTruthy();
    expect(service).toContain('host.docker.internal:host-gateway');
  });

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

describe('the panel’s nginx', () => {
  const CONFIGS = [join(ROOT, 'dashboard', 'nginx.conf'), join(ROOT, 'allinone', 'nginx.conf')];

  // #389: nginx's default request limit is 1 MB, and neither config set one, so
  // every upload larger than that — a plugin JAR, a world zip — was refused by
  // nginx before the orchestrator, whose own limit is MAX_UPLOAD_BYTES, saw it.
  it.each(CONFIGS)('leaves the upload limit to the orchestrator: %s', (file) => {
    const conf = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const api = conf.match(/location \/api\/ \{([\s\S]*?)\n {2}\}/)?.[1];
    expect(api, 'could not read the /api/ location').toBeTruthy();
    expect(api).toMatch(/^\s*client_max_body_size 0;/m);
  });

  // #401: the login limiter keys on the caller's address. The all-in-one's
  // nginx did not pass it on, so every request came from 127.0.0.1 and one
  // person's typos locked everybody out.
  it.each(CONFIGS)('tells the orchestrator who is calling: %s', (file) => {
    const conf = readFileSync(file, 'utf8');
    expect(conf).toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  });

  it.each(COMPOSE_FILES.slice(1))('believes the dashboard’s nginx about the caller by default: %s', (file) => {
    expect(readFileSync(file, 'utf8')).toMatch(/- TRUST_PROXY=\$\{TRUST_PROXY:-1\}/);
  });

  it('has the all-in-one trust its own nginx', () => {
    const init = readFileSync(join(ROOT, 'allinone', 'root', 'usr', 'local', 'bin', 'nexusinfra-init'), 'utf8');
    expect(init).toMatch(/TRUST_PROXY=\$\{TRUST_PROXY:-1\}/);
  });
});
