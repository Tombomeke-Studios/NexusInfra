# API

HTTP endpoints and event contracts. Updated with every endpoint or request/response change.

---

## Control Room (`:9000`)

### `GET /health`

Liveness probe.

```json
{ "service": "control-room", "status": "healthy", "uptimeSec": 123 }
```

### `GET /status`

Live monitoring snapshot of every heartbeat source seen on the bus.

```json
{
  "monitored": [
    { "source": "control-room", "status": "healthy", "lastSeenMsAgo": 412 }
  ],
  "thresholds": { "degradedMs": 3000, "offlineMs": 10000 }
}
```

`status` ∈ `healthy | degraded | offline` derived from last-seen age.

---

## Orchestrator (`:9200`)

The deployment control plane. Creating a deployment selects the least-loaded healthy node, records
the deployment, and commands the Node Agent to start the container. `GET /health` returns the usual
liveness shape. All responses are JSON.

> Auth (stub, MVP only): all routes below require a Bearer token from `POST /auth/login`; requests
> without a valid token get `401`. This is a local stand-in — the real FinVault-issued JWT validated
> at the API Gateway is a later phase (#20).

### `POST /auth/login`  *(public)*

Exchange seeded dev credentials for a signed JWT (12h TTL). Defaults: `admin` / `admin`
(override via `DEV_USERNAME` / `DEV_PASSWORD`; the signing key is `JWT_SECRET`).

```json
// request
{ "username": "admin", "password": "admin" }
// 200 response
{ "token": "<jwt>" }
```

`401` on bad credentials. Send the token as `Authorization: Bearer <jwt>` on every other call.

### `POST /deployments`

Create and place a deployment.

Request:

```json
{ "name": "my-nginx", "dockerImage": "nginx", "ports": { "8080": "80" }, "env": {}, "autoRestart": false, "type": "generic" }
```

`name` and `dockerImage` are required. Responses: `201` with the deployment (including its event
trail), `400` on missing fields, `503` when no healthy node is available. On success the Orchestrator
emits `infra.server.start` for the chosen node.

### `GET /deployments`

List all deployments (newest first), each joined with its config name/image and current status
(`pending | running | stopped | crashed | failed`).

### `GET /deployments/:id`

A single deployment with its full `events` audit trail. `404` if unknown.

### `POST /deployments/:id/start`

Start (or re-run) a deployment that is **not** currently running — re-places it on a healthy node and
emits `infra.server.start` from the saved config. `202` while starting, `404` if unknown, `409` if it
is already running/pending, `503` if no healthy node is available.

### `POST /deployments/:id/stop`

Request a running deployment be stopped — emits `infra.server.stop`; the agent stops **and removes**
the container (freeing its name and host ports). `202` while stopping, `404` if unknown, `409` if the
deployment is not running.

### `POST /deployments/:id/restart`

Request a running deployment be restarted — emits `infra.server.restart` with the stored container id;
the agent restarts the container and reports `server.started`. `202` while restarting, `404` if
unknown, `409` if the deployment is not running.

### `GET /nodes`

Registered nodes with their latest resources and derived `health` (`healthy | degraded | offline`).

---

## Event contract (bus API)

The full event union is defined in `shared/src/events.ts` — that file is the contract's source of
truth. Summary:

| Event type | Direction | Notes |
|---|---|---|
| `heartbeat.service` / `heartbeat.node` | any → control-room | 1s pulse; node variant carries a resources block |
| `server.start` / `server.stopped` / `server.started` / `server.crashed` | orchestrator ↔ node-agent | container lifecycle |
| `deployment.created` / `deployment.failed` | orchestrator → bus | deployment audit events |
| `payment.request` | billing-bridge → FinVault | payload shape matches FinVault's `payment.request` exactly |
| `payment.confirmed` / `payment.failed` | FinVault → billing-bridge | consumed to keep/suspend servers |

Envelopes and encryption: see [architecture.md](architecture.md#event-bus). Payload shapes for the
`payment.*` trio must never drift from FinVault's `shared/src/events.ts`.
