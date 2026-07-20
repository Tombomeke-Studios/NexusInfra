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
| `services/node-agent` | Planned (#9, #10) | Docker container lifecycle on a host node |
| `services/orchestrator` | Planned (#11–#14) | Node registry, deployment planning, lifecycle events |
| `services/billing-bridge` | Planned (#18, #19) | Runtime tracking → FinVault payments |
| `services/gateway` | Planned (#20) | JWT validation, routing, WebSocket proxy |
| `apps/web-dashboard` | Planned (#15–#17) | React dashboard |

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
| `monitoring.heartbeat.node.{id}` | node-agent (planned) | control-room |

Planned keys (defined in `shared/src/events.ts`, not yet flowing): `infra.server.*`,
`infra.deployment.*`, `bank.payment.*` — see the
[CONCEPTS routing-key table](../../CONCEPTS/integration/rabbitmq-architecture.md).

## Heartbeat / status model

1s pulse per source. Control Room derives status from last-seen age: **healthy** < 3s ≤ **degraded**
< 10s ≤ **offline**. State is in-memory (foundation phase); uptime history is a later phase.

## Persistence

Prisma + SQLite per service (FinVault pattern), PostgreSQL-ready via Prisma. No service has a
database yet; the Orchestrator gets the first one (#14). Schema source of truth: each service's
migrations directory — never documented here.
