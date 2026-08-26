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

## Putting it behind TLS (#245)

**Everything the stack speaks is plain HTTP.** The login that carries a password, the JWT on every
request afterwards, the WebSocket that opens a root shell inside a container — all of it, in the
clear. On a LAN you control that is a considered risk. The moment any of it crosses a network you do
not control, it is somebody else's session.

Nothing in the stack terminates TLS itself, deliberately: certificate renewal, HSTS and cipher choice
are a reverse proxy's job, and every host already has one it prefers. Put the panel behind one and
publish nothing else.

### What to expose, and what not to

| Service | Expose? |
|---|---|
| dashboard `8095` | Yes — behind the proxy, as the only public entry point |
| orchestrator `9200` | No. The dashboard's nginx reaches it on the internal network |
| gateway `9400` | Only if you use it as the entry point instead of the dashboard |
| node-agent `9100` | **Never.** It starts containers and opens shells; see [images.md](images.md) |
| control-room `9000`, billing-bridge `9300` | No |
| RabbitMQ `5672` / `15672` | No. Management UI least of all — it ships with `guest/guest` |

The compose files publish ports on the host so a local install works out of the box. For an exposed
host, bind the ones you are not proxying to localhost (`127.0.0.1:9200:9200`) so a stray firewall rule
cannot turn them into an entry point.

### Caddy

Caddy is the shortest path: it obtains and renews a certificate on its own, provided the domain
resolves to the host and ports 80 and 443 reach it.

```caddyfile
panel.example.com {
    reverse_proxy localhost:8095
}
```

That is the whole file. The WebSocket used by the terminal is upgraded automatically — no extra
configuration, which is the usual reason a panel's console works everywhere except behind a proxy.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8095;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The terminal (#71) is a WebSocket. Without these two the console fails
        # to connect while every other page works, which is a confusing way to
        # discover the proxy is misconfigured.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # A shell session is idle whenever nobody is typing. The default 60s read
        # timeout closes it mid-use.
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
```

### Getting the client's real address

Rate limiting (#225) keys on the caller's IP, and behind a proxy every request appears to come from
the proxy — so one address would carry everyone's budget and lock the whole installation out
together. Set `TRUST_PROXY=1` on the orchestrator so it reads `X-Forwarded-For`, and make sure the
proxy sets that header.

Only do this behind a proxy you control. `X-Forwarded-For` is a request header like any other: if the
orchestrator is reachable directly, a caller can set it themselves and choose which bucket to spend.

### Before you expose anything

- Set `ADMIN_PASSWORD` to something generated, not the one in the example file.
- Confirm `JWT_SECRET` and `INTERNAL_API_TOKEN` are not the defaults — the installer generates both
  (#191); a hand-assembled stack may not have.
- Check that only the proxy's ports answer from outside: `ss -tlnp` on the host, then try one of the
  service ports from another machine.
- Community edition refuses self-registration, so the only accounts are the ones you create. Hosted
  does not — that is the point of it, but it means the registration form is public.

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
ghcr.io/tombomeke-studios/nexusinfra/<service>:X.Y.Z-community   (+ a moving :community)
ghcr.io/tombomeke-studios/nexusinfra/<service>:X.Y.Z-hosted      (+ a moving :hosted)
ghcr.io/tombomeke-studios/nexusinfra/dashboard:X.Y.Z             (+ :latest)
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
application is about 0.1% of what ships; the weight is the base images and Prisma (#192).

Services also report their `version` and *resolved* `edition` from `GET /health`, which is the fastest
way to confirm a running container is what you think it is.

Per-image configuration — ports, environment, volumes — is in [images.md](images.md), which is the
reference for building a stack without the installer.

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
