# NexusInfra

<div align="center">

![Status](https://img.shields.io/badge/Status-Phase_2_·_Core-3b82f6?style=flat-square)
![Stack](https://img.shields.io/badge/Stack-TypeScript_·_Docker_·_RabbitMQ-3178c6?style=flat-square)
![Dashboard](https://img.shields.io/badge/Dashboard-React_·_Vite-3178c6?style=flat-square)
![Tests](https://img.shields.io/badge/Tests-Vitest-6e9f18?style=flat-square)
![License](https://img.shields.io/badge/License-Internal-64748b?style=flat-square)

</div>

> **Infrastructure & server-management platform** — deploy and run Docker containers across a fleet of
> host nodes from a single web panel, with resource-aware placement, live health monitoring, and
> usage-based billing through **[FinVault](https://github.com/Tombomeke-Studios/FinVault)** over a
> shared RabbitMQ event bus.

Design source of truth lives in [`../CONCEPTS/infrastructure-platform/`](../CONCEPTS/infrastructure-platform/)
and [`../CONCEPTS/integration/`](../CONCEPTS/integration/).

---

## Architecture

```mermaid
graph TB
    subgraph Client
        WEB["Web Dashboard<br/><small>React · Vite</small>"]
    end

    subgraph "Control plane"
        ORCH["Orchestrator<br/><small>deployments · node registry</small>"]
        MON["Control Room<br/><small>heartbeats · status</small>"]
        BILL["Billing Bridge<br/><small>runtime → payments</small>"]
    end

    subgraph "Docker hosts"
        N1["Node Agent<br/><small>host 1</small>"]
        N2["Node Agent<br/><small>host 2</small>"]
    end

    RMQ["RabbitMQ<br/><small>finvault.events</small>"]
    FV["FinVault<br/><small>payments</small>"]

    WEB -->|REST + JWT| ORCH
    ORCH <-.->|server.start / started| RMQ
    MON <-.->|heartbeats| RMQ
    BILL <-.->|payment.*| RMQ
    N1 <-.-> RMQ
    N2 <-.-> RMQ
    RMQ <-.-> FV

    style WEB fill:#3178c6,stroke:#3178c6,color:#fff
    style ORCH fill:#1d4ed8,stroke:#1d4ed8,color:#fff
    style MON fill:#1d4ed8,stroke:#1d4ed8,color:#fff
    style BILL fill:#94a3b8,stroke:#94a3b8,color:#fff
    style RMQ fill:#f97316,stroke:#f97316,color:#fff
    style FV fill:#0f766e,stroke:#0f766e,color:#fff
    style N1 fill:#374151,stroke:#374151,color:#fff
    style N2 fill:#374151,stroke:#374151,color:#fff
```

Every service speaks FinVault's on-the-wire event format (same envelope, AES-256-GCM payloads, and
`finvault.events` exchange), so the two platforms integrate with **zero FinVault-side changes**.

---

## Components

| Component | Status | Role |
|---|---|---|
| **`shared`** | ✅ Built | Event contract — envelope, AES-256-GCM payload encryption, RabbitMQ helpers (FinVault-compatible) |
| **Control Room** | ✅ Built | Heartbeat monitoring; derives `healthy → degraded → offline` status; HTTP status view |
| **Node Agent** | ✅ Built | Runs on a Docker host; starts/stops/restarts containers and reports heartbeats + CPU/RAM/disk |
| **Orchestrator** | ✅ Built | Node registry, deployment API with resource-aware placement, and lifecycle tracking |
| **Web Dashboard** | 🚧 In progress | React/Vite server panel: login, overview, new-deployment form, live server list |
| **Billing Bridge** | 📋 Planned | Runtime tracking → `payment.request` to FinVault; suspension on failure |
| **API Gateway** | 📋 Planned | Production auth (FinVault JWT), routing, WebSocket proxy |

---

## The deployment loop

```mermaid
sequenceDiagram
    participant U as User (Dashboard)
    participant O as Orchestrator
    participant Q as RabbitMQ
    participant A as Node Agent

    U->>O: POST /deployments {image, ports}
    O->>O: pick least-loaded healthy node · record deployment
    O->>Q: server.start {node, image}
    Q->>A: deliver command
    A->>A: docker run
    A->>Q: server.started {containerId}
    Q->>O: update status → running
    U->>O: GET /deployments → running
```

---

## Quickstart

```bash
# 1. Install workspace dependencies
npm install

# 2. Configure. For FinVault integration, RABBITMQ_URL and FINVAULT_MESSAGE_KEY
#    must match FinVault's values (see .env.example).
cp .env.example .env

# 3a. Run the stack in Docker (RabbitMQ + Control Room + Node Agent + Orchestrator)
docker-compose up

# 3b. …or build and run locally against your own broker
npm run build
```

| Surface | URL |
|---|---|
| Orchestrator API | `http://localhost:9200` — see [docs/api.md](docs/api.md) |
| Control Room health / status | `http://localhost:9000/health` · `/status` |
| RabbitMQ management UI | `http://localhost:15672` (guest / guest) |

### Run the dashboard

```bash
npm --workspace dashboard run dev   # http://localhost:5173
```

Sign in with the seeded dev user (`admin` / `admin`), then create a deployment from the panel.

### Or drive the loop from the CLI

```bash
# authenticate
TOKEN=$(curl -s -X POST http://localhost:9200/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')

# deploy nginx and publish 8080 -> 80
curl -X POST http://localhost:9200/deployments \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"my-nginx","dockerImage":"nginx","ports":{"8080":"80"}}'

curl -H "authorization: Bearer $TOKEN" http://localhost:9200/deployments  # → running
docker ps                                                                 # nginx container up
curl http://localhost:8080                                                # nginx welcome page
```

---

## Integration with FinVault

Both platforms share one RabbitMQ topic exchange, `finvault.events`, with a dead-letter exchange
`finvault.events.dlx`. Event payloads are AES-256-GCM encrypted with a key derived from
`FINVAULT_MESSAGE_KEY`; the event `type` stays readable for routing. Because `shared/` reproduces
FinVault's envelope and encryption exactly, either platform can consume the other's events — verified
by a round-trip test.

```mermaid
sequenceDiagram
    participant BB as NexusInfra (Billing Bridge)
    participant Q as finvault.events
    participant FV as FinVault

    BB->>Q: payment.request
    Q->>FV: process payment
    alt Paid
        FV->>Q: payment.confirmed
        Q->>BB: keep servers running
    else Unpaid
        FV->>Q: payment.failed
        Q->>BB: suspend the user's servers
    end
```

To connect the two, point `RABBITMQ_URL` at FinVault's broker and set the same `FINVAULT_MESSAGE_KEY`.

---

## Testing

```bash
npm test     # backend (Node) + dashboard (jsdom) via Vitest
npm run lint # ESLint across all workspaces
```

The suite includes the FinVault wire-compatibility guard that locks the envelope shape and encryption
layout — never change those without an equivalent change in FinVault.

---

## Project layout

```
NexusInfra/
├── shared/            # Event contract + RabbitMQ helpers (FinVault-compatible)
├── services/
│   ├── control-room/  # Heartbeat monitoring + status endpoint
│   ├── node-agent/    # Docker container lifecycle + node heartbeats
│   └── orchestrator/  # Deployment API, node registry, lifecycle (Prisma/SQLite)
├── dashboard/         # React + Vite web panel
├── docs/              # architecture · api · security · deployment
├── docker-compose.yml
└── .env.example
```

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Services as built, event-bus topology, routing keys, status model |
| [docs/api.md](docs/api.md) | HTTP endpoints and the event-contract summary |
| [docs/security.md](docs/security.md) | Payload encryption, secrets handling, auth plan |
| [docs/deployment.md](docs/deployment.md) | Local dev, image pattern, CI, combined FinVault deployment |
| [TODO.md](TODO.md) | Working checklist grouped per branch |

<div align="center">
<sub>Part of the <strong><a href="https://github.com/Tombomeke-Studios">Tombomeke Studios</a></strong> product ecosystem.</sub>
</div>
