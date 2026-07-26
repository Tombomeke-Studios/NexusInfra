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
| `services/node-agent` | ✅ Built | Docker container lifecycle (with resource-limit/restart enforcement) + node heartbeat/resource reporting |
| `services/orchestrator` | ✅ Built | Node registry, deployment API + least-loaded node selection, lifecycle events |
| `dashboard` | ✅ Built (MVP) | React/Vite panel: login, overview, deployment form, live server list + stop |
| `services/billing-bridge` | ✅ Built (hosted) | Runtime tracking, credit wallet + ledger, FinVault top-up flow, plan quotas — inert in community edition (#146) |
| `services/gateway` | ✅ Built (HTTP) | Single entry point: CORS, per-client rate limiting, JWT validation, reverse proxy to the orchestrator (#20). WS terminal proxy pending (#69/#71) |
| Live container console | ✅ Logs + stats (SSE) + terminal (WS) | Orchestrator proxies the agent's `/logs` + `/stats` SSE and the `/terminal` WebSocket (interactive xterm.js shell, JWT-authenticated) to the dashboard (#68/#71) |

## Editions (open-core)

One codebase, two editions via `NEXUS_EDITION=community|hosted` (default `community`; anything
unrecognised falls back to community). **Community** is the standalone self-hosted manager with no
billing/FinVault dependency; **hosted** turns on usage-based billing for the multi-tenant
hosting-provider scenario. Services resolve their edition from `shared`'s `getEdition()`; the
dashboard reads it from the Orchestrator's public `GET /config` (`{ edition }`) and renders billing
UI only in hosted. Full design: [billing.md](billing.md).

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
| `infra.server.started` / `infra.server.stopped` / `infra.server.crashed` | node-agent | orchestrator **and** billing-bridge (runtime intervals, hosted) |
| `infra.deployment.created` | orchestrator | billing-bridge (learns owner + limits for tracking, hosted) |
| `bank.payment.request` | billing-bridge | FinVault (credit top-up charge) |
| `bank.payment.confirmed` / `bank.payment.failed` | FinVault | billing-bridge (add/mark-failed credit) |
| `billing.server.suspend` | billing-bridge (cycle runner) | orchestrator (stops the named servers) |
| `invoice.generate` | billing-bridge (cycle runner) | FinVault (monthly invoice record) |
| `monitoring.heartbeat.node.{id}` | node-agent | control-room **and** orchestrator (node registry) |

Node Agents each bind their own queue `nexusinfra.node-agent.{nodeId}` to the three `infra.server.*`
command keys and ignore commands whose payload `nodeId` is not theirs. The Orchestrator binds one
queue `nexusinfra.orchestrator` to the node heartbeat topic (to maintain its node registry) and the
three `infra.server.*` report keys (to update deployment state). In the hosted edition the Billing
Bridge binds queue `nexusinfra.billing-bridge` to `infra.deployment.created`, the three
`infra.server.*` report keys, and `bank.payment.confirmed`/`.failed`.

The monthly cycle runner (billing-bridge, hosted) publishes `billing.server.suspend` — the Orchestrator
consumes it and stops the named deployments — and `invoice.generate` (→ FinVault). These are
NexusInfra-only routing keys added in #145; the envelope/encryption contract is unchanged, and the
payment `type`s stay wire-compatible with FinVault. In the hosted edition the Orchestrator also
enforces the plan's `maxServers`/`maxDatabases` at create-time by asking the Billing Bridge
(`GET /billing/:userId/quota`), failing open if it's unreachable so a billing outage never blocks
deploys. See the [CONCEPTS routing-key table](../../CONCEPTS/integration/rabbitmq-architecture.md)
and [billing.md](billing.md).

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

In the hosted edition the Billing Bridge keeps its own SQLite store: tunable pricing/quota plans,
per-deployment runtime intervals, a per-user credit wallet, an append-only credit ledger (top-ups +
charges), and monthly billing cycles. Same "schema lives in `prisma/migrations`, not in docs" rule.
