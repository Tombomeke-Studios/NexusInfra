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
and sign in with the seeded dev user (`admin` / `admin`).

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

## CI/CD

- `.github/workflows/ci.yml`: npm ci → build → lint → test, on PRs and pushes to
  `dev` / `staging` / `main`.
- Releases: merges reach `main` only via `staging`; tag `vX.Y.Z` after each main merge
  (see CLAUDE.md branch strategy).
