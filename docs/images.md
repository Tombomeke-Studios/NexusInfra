# Image reference

Everything needed to assemble a NexusInfra stack by hand, without running an installer.

The installer in the release archive is a convenience, not the supported path — plenty of people
would rather write their own Compose file, point services at a broker they already run, put their own
reverse proxy in front, or spread agents across several machines. This page is for them.

---

## The all-in-one image

If you would rather not assemble anything, there is one image per edition containing the whole stack —
orchestrator, node agent, control room, gateway, nginx with the dashboard, and a broker — supervised
inside a single container.

```bash
docker run -d \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v nexusinfra:/data \
  -p 8095:80 \
  ghcr.io/tombomeke-studios/nexusinfra-community
```

No tag needed, no configuration required. On first start it generates an administrator password and
the two secrets, prints the credentials once, and keeps them in the volume. Supply any of
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `JWT_SECRET` or `INTERNAL_API_TOKEN` and yours are used instead.

Replace `community` with `hosted` for the multi-tenant edition; that one also expects
`FINVAULT_MESSAGE_KEY`.

| | |
|---|---|
| Image | `ghcr.io/tombomeke-studios/nexusinfra-community` · `nexusinfra-hosted` |
| Volume | `/data` — databases, backups, broker state and the generated secrets |
| Port | 80 |
| Needs | the Docker socket |

**Using a broker you already run:** set `RABBITMQ_URL` and the built-in one is not started. The
hosted edition needs this to share FinVault's broker.

### What it deliberately cannot do

It is one machine. That covers most self-hosting, and it is an honest limit rather than a temporary
one:

- **A second host runs the standalone `nexusinfra/node-agent` image**, pointed at this container's
  broker. The all-in-one cannot spread itself across machines.
- **You cannot restart one service without the others.** Everything shares a container lifecycle.
- **Logs are interleaved**, prefixed per service but in one stream.
- **It is larger than any single component image**, because it contains all of them plus a broker.

For multi-node, an existing broker, an existing reverse proxy, or independent restarts, use the
component images below.

---

## The six images

```
ghcr.io/tombomeke-studios/nexusinfra/<service>:<version>-<edition>
```

`<edition>` is `community` or `hosted`; moving `:community` and `:hosted` tags track the latest of
each. **The image decides its own edition** — there is no variable to set, and a service asked to run
as the edition it was not built for exits rather than starting in a half-configured state.

| Image | Runs | Port | Purpose |
|---|---|---|---|
| `nexusinfra/orchestrator` | once | 9200 | Accounts, authorization, deployments, teams, schedules. Owns the database. |
| `nexusinfra/node-agent` | **once per Docker host** | 9100 | Container lifecycle, logs, stats, files, exec, terminal, databases, backups. |
| `nexusinfra/control-room` | once | 9000 | Heartbeat monitoring, health status, uptime. |
| `nexusinfra/gateway` | once | 9400 | External entry point: CORS, rate limiting, JWT validation, reverse proxy. |
| `nexusinfra/dashboard` | once | 80 | The web panel, served by nginx. |
| `nexusinfra/billing-bridge` | once, **hosted only** | 9300 | Usage metering, credit wallet, monthly cycle, FinVault top-ups. |

You also need a **RabbitMQ** broker (`rabbitmq:3-management-alpine` is fine). Every service reports
its version and resolved edition on `GET /health`, which is the quickest way to confirm a container is
what you think it is.

### What runs where

Only the **node agent** is per-machine. The other five are a control plane and run once for the whole
installation, on whichever host you like. To add capacity, run another agent with a distinct
`NODE_ID` pointed at the same broker; it registers itself and the scheduler starts placing servers on
it. Nothing else changes.

---

## Configuration

### Shared by every service

| Variable | Required | Notes |
|---|---|---|
| `RABBITMQ_URL` | yes | e.g. `amqp://user:pass@rabbitmq:5672`. Point this at your own broker if you have one. |
| `FINVAULT_MESSAGE_KEY` | hosted | Derives the AES-256-GCM key for event payloads. **Must be identical to FinVault's**, or neither platform can read the other's events. Optional in community. |
| `PORT` | no | Overrides the default in the table above. |
| `NEXUS_EDITION` | no | Ignored in a released image; the image's own edition wins. Only meaningful when running from source. |

### `orchestrator`

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `file:/data/orchestrator.db`. Mount a volume at `/data`; migrations run automatically at start. |
| `JWT_SECRET` | yes | Signs login tokens. Anyone holding it can mint a token for any account — use 32 random bytes. |
| `INTERNAL_API_TOKEN` | yes | Shared secret for reaching the node agent. Must match the agents'. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | The administrator seeded on first start. A warning is logged on every start while the default password is in place. |
| `NODE_AGENT_URL` | no | Single-node fallback. Multi-node setups learn each agent's address from its heartbeat. |
| `CONTROL_ROOM_URL` | no | For surfacing platform health in the panel. |
| `TRUST_PROXY` | no | Number of reverse proxies in front (1 for the setup in [deployment.md](deployment.md#putting-it-behind-tls-245)). Makes per-IP rate limiting measure the caller rather than the proxy. Leave unset unless only the proxy can reach this process — `X-Forwarded-For` is caller-supplied. |
| `BILLING_BRIDGE_URL` | hosted | Where plan-quota checks go. |
| `DATABASE_PUBLIC_HOST` | no | Hostname given to users connecting to a provisioned database. Defaults to `localhost`. |

Volume: `/data` — the database. Back this up.

### `node-agent`

| Variable | Required | Notes |
|---|---|---|
| `NODE_ID` | yes | Unique per host. |
| `INTERNAL_API_TOKEN` | yes | Must match the orchestrator's. |
| `AGENT_URL` | no | How the orchestrator reaches this agent, advertised on its heartbeat. Defaults to `http://<hostname>:<PORT>`, which works on a Compose network; set it explicitly for anything else. |
| `BACKUP_DIR` | no | Where backup tarballs live. Point at a volume so they survive restarts. |
| `DISK_PATH` | no | **Rarely needed.** Which filesystem to report disk usage for (#276). The agent works this out by itself: it asks Docker for its data root and measures that when it is readable, and otherwise measures its own root — which under overlay2 already reports the filesystem the Docker data sits on, because that is where the container's writable layer lives. Set this only when the disk you care about is somewhere else, e.g. volumes on a second drive mounted into the agent. A node that cannot measure at all reports nothing rather than zero. |
| `IMPORT_ROOT` | no | Enables importing existing server directories (#268). A path a person may point a new server at, so it runs against files already on this host. **Unset means the feature is off, which is the default.** Only a platform administrator may use it, and the agent refuses anything that does not resolve inside this root. Mount the same path into the agent container so it can see it. |

Requires the Docker socket: `-v /var/run/docker.sock:/var/run/docker.sock`.

> **Do not publish this port.** The agent's API starts containers and opens shells inside them. It is
> reached by the orchestrator over an internal network and guarded by `INTERNAL_API_TOKEN`; exposing
> it to a network turns that token into the only thing between an attacker and your Docker daemon.

### `gateway`

| Variable | Required | Notes |
|---|---|---|
| `ORCHESTRATOR_URL` | yes | The backend it proxies to. |
| `JWT_SECRET` | yes | Must match the orchestrator's — it validates the same tokens. |
| `RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST` | no | Default 50 and 100 per client. |

### `billing-bridge` (hosted only)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `file:/data/billing.db`; mount a volume at `/data`. |
| `BILLING_WALLET_ID` | no | NexusInfra's receiver wallet id on top-up requests to FinVault. |

### `dashboard`

No configuration. It is built per edition and served by nginx, which proxies `/api` to a host named
`orchestrator` on the same network. If your orchestrator has a different name, put your own reverse
proxy in front or supply your own nginx configuration.

---

## A minimal stack

Enough to run, on one machine. Replace the placeholder secrets — the stack will start with anything,
which is exactly the problem.

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management-alpine
    volumes: [rabbitmq_data:/var/lib/rabbitmq]

  orchestrator:
    image: ghcr.io/tombomeke-studios/nexusinfra/orchestrator:community
    ports: ["9200:9200"]
    environment:
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
      DATABASE_URL: file:/data/orchestrator.db
      JWT_SECRET: ${JWT_SECRET:?}
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:?}
      ADMIN_EMAIL: you@example.com
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?}
      NODE_AGENT_URL: http://node-agent:9100
    volumes: [orchestrator_data:/data]
    depends_on: [rabbitmq]

  node-agent:
    image: ghcr.io/tombomeke-studios/nexusinfra/node-agent:community
    environment:
      NODE_ID: node-local
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
      INTERNAL_API_TOKEN: ${INTERNAL_API_TOKEN:?}
      AGENT_URL: http://node-agent:9100
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on: [rabbitmq]

  control-room:
    image: ghcr.io/tombomeke-studios/nexusinfra/control-room:community
    environment:
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
    depends_on: [rabbitmq]

  dashboard:
    image: ghcr.io/tombomeke-studios/nexusinfra/dashboard:community
    ports: ["8095:80"]
    depends_on: [orchestrator]

volumes:
  rabbitmq_data:
  orchestrator_data:
```

The gateway is omitted here because the dashboard talks to the orchestrator directly. Add it when you
want rate limiting and a single external entry point, and point your reverse proxy at it instead.

For hosted, use the `hosted` tags, add `billing-bridge`, and set `FINVAULT_MESSAGE_KEY` on every
service to the same value FinVault uses.

---

## Adding a machine

On the second host, with the same broker and token:

```bash
docker run -d --name nexusinfra-node-agent \
  -e NODE_ID=node-berlin \
  -e RABBITMQ_URL=amqp://user:pass@broker.example.com:5672 \
  -e INTERNAL_API_TOKEN=... \
  -e AGENT_URL=http://10.0.0.42:9100 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/tombomeke-studios/nexusinfra/node-agent:community
```

It registers via heartbeats and becomes a placement target. `AGENT_URL` must be an address the
orchestrator can actually reach, and that path should not cross an untrusted network — see
[security.md](security.md).

---

## Before exposing any of this

- Terminate TLS in front of the dashboard and the gateway. Nothing here does it for you.
- Replace the RabbitMQ credentials; do not leave `guest/guest` reachable.
- Keep the node agent's port off any public interface.
- Generate real values for `JWT_SECRET` and `INTERNAL_API_TOKEN`. `openssl rand -hex 32` twice.

The full model, including what is deliberately not protected yet, is in [security.md](security.md).
