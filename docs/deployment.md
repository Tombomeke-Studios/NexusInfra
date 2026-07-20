# Deployment

Updated with every change to Docker, CI/CD, or deployment topology.

---

## Local / dev

```bash
cp .env.example .env      # set FINVAULT_MESSAGE_KEY to match FinVault for integration
npm install
docker-compose up          # RabbitMQ (5672 / UI 15672) + Control Room (9000)
```

Or hybrid: `docker-compose up rabbitmq` + `npm run dev` for hot-reloading services.

The `node-agent` service mounts the host Docker socket (`/var/run/docker.sock`) so it can start
and stop real containers. On Windows/macOS Docker Desktop exposes this path to Linux containers.
Set `NODE_ID` per host when running multiple agents.

## Docker images

Every service uses the same **multi-stage workspace build** (see
`services/control-room/Dockerfile`): builder stage compiles `shared` then the service; runtime stage
copies only `dist/` + production deps. Build context is always the **repo root**.

## Combined deployment with FinVault

Run one broker for both platforms: omit NexusInfra's `rabbitmq` service and point `RABBITMQ_URL` at
FinVault's `finvault-rabbitmq` container (shared Docker network required). Both stacks assert the
same exchanges idempotently — start order does not matter.

## CI/CD

- `.github/workflows/ci.yml`: npm ci → build → lint → test, on PRs and pushes to
  `dev` / `staging` / `main`.
- Releases: merges reach `main` only via `staging`; tag `vX.Y.Z` after each main merge
  (see CLAUDE.md branch strategy).
