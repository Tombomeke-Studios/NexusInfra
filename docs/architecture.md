# Architecture

System design as built. The conceptual design lives in
[`../../CONCEPTS/infrastructure-platform/architecture.md`](../../CONCEPTS/infrastructure-platform/architecture.md);
this doc tracks the implemented reality and is updated with every change to services, endpoints,
event contracts, or infra topology.

---

## Services

| Service | Status | Role |
|---|---|---|
| `shared` (library) | ✅ Built | Event contract + RabbitMQ helpers, wire-compatible with FinVault |
| `services/control-room` | ✅ Built | Heartbeat monitoring, status thresholds, HTTP status API |
| `services/node-agent` | ✅ Built | Docker container lifecycle + node heartbeat/resource reporting |
| `services/orchestrator` | ✅ Built | Node registry, deployment API + least-loaded node selection, lifecycle events |
| `dashboard` | ✅ Built (MVP) | React/Vite panel: login, overview, deployment form, live server list + stop |
| `services/billing-bridge` | Planned (#18, #19) | Runtime tracking → FinVault payments |
| `services/gateway` | Planned (#20) | JWT validation, routing, WebSocket proxy |
| Real-time container logs | Planned (#17) | WebSocket log streaming in the dashboard |

## Event bus

Single durable **topic exchange `finvault.events`** shared with FinVault, plus fanout DLX
`finvault.events.dlx` → queue `finvault.events.dlq`. Consumers bind their own durable queue with the
DLX attached and `nack` without requeue on processing errors.

Envelope: `{ eventId, timestamp, source, event: { type, payload } }`. Payloads are AES-256-GCM
encrypted when `FINVAULT_MESSAGE_KEY` is set; the `type` stays plaintext for routing. Read payloads
via `readPayload()` only.

### Routing keys in use

| Routing key | Publisher | Consumer |
|---|---|---|
| `monitoring.heartbeat.service.{name}` | every service (1s) | control-room |
| `monitoring.heartbeat.node.{id}` | node-agent (1s pulse, resources every 5s) | control-room |
| `infra.server.start` / `infra.server.stop` / `infra.server.restart` | orchestrator | node-agent |
| `infra.server.started` / `infra.server.stopped` / `infra.server.crashed` | node-agent | orchestrator |
| `infra.deployment.created` | orchestrator | (dashboard/audit; no binder yet) |
| `monitoring.heartbeat.node.{id}` | node-agent | control-room **and** orchestrator (node registry) |

Node Agents each bind their own queue `nexusinfra.node-agent.{nodeId}` to the three `infra.server.*`
command keys and ignore commands whose payload `nodeId` is not theirs. The Orchestrator binds one
queue `nexusinfra.orchestrator` to the node heartbeat topic (to maintain its node registry) and the
three `infra.server.*` report keys (to update deployment state).

Planned keys (defined in `shared/src/events.ts`, not yet flowing): `bank.payment.*` — see the
[CONCEPTS routing-key table](../../CONCEPTS/integration/rabbitmq-architecture.md).

## Heartbeat / status model

1s pulse per source. Control Room derives status from last-seen age: **healthy** < 3s ≤ **degraded**
< 10s ≤ **offline**. State is in-memory (foundation phase); uptime history is a later phase.

## Persistence

Prisma + SQLite per service (FinVault pattern), PostgreSQL-ready via Prisma. The Orchestrator holds
the first database: nodes (maintained from heartbeats), server configs, deployments, and an
append-only deployment-event audit trail. Schema source of truth: the service's
`prisma/migrations` directory — never documented here.

The Orchestrator's node registry mirrors the same last-seen status model above (healthy < 3s ≤
degraded < 10s ≤ offline); only `healthy` nodes are eligible for placement.
