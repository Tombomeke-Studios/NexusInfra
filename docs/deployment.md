# Deployment

Updated with every change to Docker, CI/CD, or deployment topology.

---

## Local / dev

```bash
cp .env.example .env      # set FINVAULT_MESSAGE_KEY to match FinVault for integration
docker-compose up --build # full stack
```

The stack publishes: RabbitMQ (`5672` / UI `15672`), Control Room (`9000`), Node Agent (`9100`),
Orchestrator (`9200`), and the dashboard (`8095`). Open the dashboard at `http://localhost:8095`
and sign in as the administrator seeded on first start — `ADMIN_EMAIL` (default `admin@local`) with
`ADMIN_PASSWORD` (default `admin`). The service warns on every start while that default is in place;
set a real password before the panel is reachable by anyone else.

Or hybrid: `docker-compose up rabbitmq` + `npm run dev` (backend) and
`npm --workspace dashboard run dev` (UI on `5173`) for hot reloading.

The `node-agent` service mounts the host Docker socket (`/var/run/docker.sock`) so it can start
and stop real containers. On Windows/macOS Docker Desktop exposes this path to Linux containers.
Set `NODE_ID` per host when running multiple agents.

**Host port already in use?** If another app holds a port the stack wants (for example a sibling
project on `9000`), add a local `docker-compose.override.yml` that remaps only that service's
published port. The override file is git-ignored, so it never affects other machines:

```yaml
services:
  control-room:
    ports: !override
      - "9002:9000"
```

## Docker images

Every service uses the same **multi-stage workspace build** (see
`services/control-room/Dockerfile`): builder stage compiles `shared` then the service; runtime stage
copies only `dist/` + production deps. Build context is always the **repo root**.

The **Orchestrator** image is based on Debian slim (not Alpine) with `openssl` installed, because
Prisma's query/schema engines require OpenSSL and do not run on Alpine/musl. It applies
`prisma migrate deploy` on startup before serving. The **dashboard** builds to static assets served
by nginx, which reverse-proxies `/api` to the Orchestrator.

## Running nodes on other machines (remote / multi-node)

NexusInfra is designed for this: a **Node Agent is just a process that connects to the shared broker
and drives its local Docker daemon**. To add another machine (a Linux server, a second desktop, etc.)
as a managed node:

1. Run a Node Agent on that machine (any OS with Docker — the agent is Node.js + dockerode).
2. Point its `RABBITMQ_URL` at the **central broker** (the one the Orchestrator/Control Room use) and
   give it a unique `NODE_ID`. Set the same `FINVAULT_MESSAGE_KEY`.
3. It registers automatically via heartbeats; the Orchestrator then places deployments on it using the
   same least-loaded selection. Commands are addressed by `nodeId`, so each agent only runs its own.

The control plane (Orchestrator, Control Room, dashboard) can stay on one host (e.g. this desktop
alongside FinVault) while agents run anywhere. Practical caveats for a real multi-machine setup:

- **Networking & security:** the broker must be reachable from each node, over authenticated, ideally
  TLS-secured AMQP — do **not** expose `guest/guest` beyond localhost. This is Phase 5 hardening.
- **Published ports are per-node:** a container's published port lives on *that node's* host, so you
  reach a deployed server at that node's IP:port. A unifying reverse proxy / gateway is a later phase.
- Multi-node placement is tracked as roadmap item #21.

## Combined deployment with FinVault

Run one broker for both platforms: omit NexusInfra's `rabbitmq` service and point `RABBITMQ_URL` at
FinVault's `finvault-rabbitmq` container (shared Docker network required). Both stacks assert the
same exchanges idempotently — start order does not matter.

## Releases & editions (#179)

NexusInfra ships as **two products from one codebase**, selected by `NEXUS_EDITION`:

| | **Community** | **Hosted** |
|---|---|---|
| For | anyone self-hosting the panel on their own machines | the public/portfolio instance |
| Sign-up | administrator creates accounts | customers register themselves |
| Billing, FinVault, quotas | off | on (adds the Billing Bridge) |

Tagging `vX.Y.Z` runs `.github/workflows/release.yml`, which re-runs the full suite in both editions
and then publishes to GHCR:

```
ghcr.io/tombomeke-studios/nexusinfra-<service>:X.Y.Z-community   (+ a moving :community)
ghcr.io/tombomeke-studios/nexusinfra-<service>:X.Y.Z-hosted      (+ a moving :hosted)
ghcr.io/tombomeke-studios/nexusinfra-dashboard:X.Y.Z             (+ :latest)
```

**The tag decides the edition, and nothing else has to.** Each image carries a stamp recording the
edition it was built for, and that stamp outranks the environment: pulling `:hosted` is enough, with
nothing to declare afterwards. A service asked to run as the edition it was not built for **exits**
with a message naming both — the community images do not contain the hosted code, so starting anyway
would mean a half-enabled billing system rather than a working one. Running from source is
unaffected: with no stamp, `NEXUS_EDITION` decides as it always has.

**The community build genuinely does not contain the hosted code.** This matters most for the
dashboard, which is served to a browser: the billing page is aliased to a stub at build time and its
route is compiled out, and the image build runs `verify-edition.mjs` against the built bundle so a
regression fails the build instead of shipping quietly. `billing-bridge` is built for hosted only —
a community build of it would be a build of nothing.

*A note on size:* excluding that code saves roughly 5 KB of a 288 KB bundle. It is worth doing for
open-core integrity — self-hosters receive only code they can run — not for image size. Measured, the
application is about 0.1% of what ships; the weight is the base images and Prisma (#191).

Services also report their `version` and *resolved* `edition` from `GET /health`, which is the fastest
way to confirm a running container is what you think it is.

### The release archive

Each release attaches **one** archive, `nexusinfra-X.Y.Z.zip` (and a `.tar.gz`), containing both
edition bundles and an installer:

```
nexusinfra-X.Y.Z/
  install.sh · install.ps1   ask which edition, generate secrets, write .env, start
  README.md                  which edition to choose and why
  community/                 compose + .env.example + README, pinned to this release
  hosted/                    the same, plus billing-bridge
```

Choosing an edition is a question the installer asks, not a download you have to get right
beforehand. Neither bundle needs a checkout of this repository. Both are pinned to the exact release
they shipped with, so an old archive keeps installing the same thing.

This differs from the repo-root `docker-compose.yml`, which **builds from source** and is for
development.

## CI/CD

- `.github/workflows/ci.yml`: npm ci → build → lint → test, on PRs and pushes to
  `dev` / `staging` / `main`. The suite runs **twice** — once as `community` (the default) and once
  with `NEXUS_EDITION=hosted` — because billing routes, plan quotas and signup policy only execute
  in the hosted edition and would otherwise ship untested.
- Releases: merges reach `main` only via `staging`; tag `vX.Y.Z` after each main merge
  (see CLAUDE.md branch strategy).
