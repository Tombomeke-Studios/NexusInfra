# NexusInfra

![Status](https://img.shields.io/badge/Status-Phase_2_·_Core-3b82f6?style=flat-square)
![Stack](https://img.shields.io/badge/Stack-TypeScript_·_Node.js_·_RabbitMQ-3178c6?style=flat-square)

> Infrastructure & server-management platform with Docker orchestration, node agents, and usage-based
> billing. Integrates with **FinVault** for payment processing via an event-driven Billing Bridge over RabbitMQ.

Design docs live in [`../CONCEPTS/infrastructure-platform/`](../CONCEPTS/infrastructure-platform/) and
[`../CONCEPTS/integration/`](../CONCEPTS/integration/).

---

## Status — Phase 2 (Core)

This repo currently contains, from the roadmap:

- **Monorepo tooling** — npm workspaces, TypeScript (ESM), Docker Compose.
- **`shared/`** — the event contract: envelope, AES-256-GCM payload encryption, and RabbitMQ
  publish/consume helpers. **Wire-compatible with FinVault** (same envelope, algorithm, and
  `finvault.events` exchange).
- **`services/control-room/`** — heartbeat monitoring service with a `/health` and `/status` endpoint.
- **`services/node-agent/`** — runs on a Docker host; starts/stops/restarts containers via the Docker
  API and reports heartbeats + CPU/RAM/disk.
- **`services/orchestrator/`** — the deployment control plane: a Prisma/SQLite-backed node registry and
  deployment API that places containers on the least-loaded healthy node and tracks their lifecycle.

This closes the core loop: **create a deployment → the Orchestrator picks a node and commands the
Node Agent → a real container runs → its status flows back**.

Not yet built (later phases): Web Dashboard, Billing Bridge service logic, API Gateway.
The **event contract** for billing (`payment.request` / `payment.confirmed` / `payment.failed`) is already
defined so the Phase 4 FinVault integration needs no re-plumbing.

---

## Quickstart

```bash
# 1. Install
npm install

# 2. Configure — copy and edit. For FinVault integration, RABBITMQ_URL and
#    FINVAULT_MESSAGE_KEY MUST match FinVault's values (see .env.example).
cp .env.example .env

# 3a. Run everything in Docker (RabbitMQ + Control Room + Node Agent + Orchestrator)
docker-compose up

# 3b. …or run locally against your own broker
npm run build        # compile shared, then services (also generates the Prisma client)
npm run dev          # watch mode for shared + control-room
```

- Control Room health: `http://localhost:9000/health` · live status: `/status`
- Orchestrator API: `http://localhost:9200` — see [docs/api.md](docs/api.md)
- RabbitMQ management UI: `http://localhost:15672` (guest/guest)

### Try the deployment loop

With the stack up (and Docker available to the Node Agent), create a deployment and watch a real
container start:

```bash
# Deploy nginx and publish port 8080 -> 80
curl -X POST http://localhost:9200/deployments \
  -H 'content-type: application/json' \
  -d '{"name":"my-nginx","dockerImage":"nginx","ports":{"8080":"80"}}'

curl http://localhost:9200/deployments   # status flips pending -> running
docker ps                                 # the nginx container is running
curl http://localhost:8080                # nginx welcome page
```

Run the tests (includes the FinVault wire-compatibility test):

```bash
npm test
```

---

## How it integrates with FinVault

Both platforms share a single RabbitMQ topic exchange, `finvault.events`, with a dead-letter exchange
`finvault.events.dlx`. Event payloads are AES-256-GCM encrypted with a key derived from
`FINVAULT_MESSAGE_KEY`; the event `type` stays readable for routing. Because NexusInfra's `shared/` package
reproduces FinVault's envelope and encryption exactly, an event NexusInfra publishes can be decrypted and
consumed by FinVault (and vice versa) with **zero FinVault-side changes** — verified by the round-trip test.

```
NexusInfra Billing Bridge ──payment.request──▶ finvault.events ──▶ FinVault Wallet Service
FinVault Wallet Service ──payment.confirmed/failed──▶ finvault.events ──▶ NexusInfra Billing Bridge
```

To connect the two, point NexusInfra's `RABBITMQ_URL` at FinVault's broker and set the same
`FINVAULT_MESSAGE_KEY`.

---

## Layout

```
NexusInfra/
├── shared/                     # Event contract + RabbitMQ helpers (wire-compatible with FinVault)
│   └── src/{events,rabbitmq,heartbeat}.ts
├── services/
│   ├── control-room/           # Heartbeat monitoring + health endpoint
│   ├── node-agent/             # Docker container lifecycle + node heartbeats
│   └── orchestrator/           # Deployment API, node registry, lifecycle (Prisma/SQLite)
├── docker-compose.yml          # RabbitMQ + Control Room + Node Agent + Orchestrator
└── .env.example
```
