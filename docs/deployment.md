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

## Combined deployment with FinVault

Run one broker for both platforms: omit NexusInfra's `rabbitmq` service and point `RABBITMQ_URL` at
FinVault's `finvault-rabbitmq` container (shared Docker network required). Both stacks assert the
same exchanges idempotently — start order does not matter.

## CI/CD

- `.github/workflows/ci.yml`: npm ci → build → lint → test, on PRs and pushes to
  `dev` / `staging` / `main`.
- Releases: merges reach `main` only via `staging`; tag `vX.Y.Z` after each main merge
  (see CLAUDE.md branch strategy).
