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
{
  "name": "my-nginx",
  "dockerImage": "nginx",
  "ports": { "8080": "80" },
  "env": {},
  "type": "app",
  "autoRestart": true,
  "resourceLimits": { "cpuPercent": 50, "ramPercent": 50, "diskPercent": 50, "swapPercent": 0, "ioPriority": "normal", "restartPolicy": "on-failure", "oomKill": false }
}
```

`name` and `dockerImage` are required; the rest are optional and stored with the server config (#106) so
a re-start reuses them. The limits ride on `server.start` and the Node Agent enforces them on the
container — RAM/CPU caps, swap, block-I/O weight, restart policy and the OOM killer (#107). Responses:
`201` with the deployment (including its event trail), `400` on missing fields, `503` when no healthy
node is available. On success the Orchestrator emits `infra.server.start` for the chosen node.

### `GET /deployments`

List all deployments (newest first), each joined with its config name/image and current status
(`pending | running | stopped | crashed | failed`).

### `GET /deployments/:id`

A single deployment with its full `events` audit trail. `404` if unknown.

### `POST /deployments/:id/start`

Start (or re-run) a deployment that is **not** currently running — re-places it on a healthy node and
emits `infra.server.start` from the saved config. `202` while starting, `404` if unknown, `409` if it
is already running/pending, `503` if no healthy node is available.

### `GET /deployments/:id/logs`

Server-Sent Events stream of the running container's logs — one `data:` line per log line.
Proxied from the owning Node Agent's internal `/logs/:containerId`. `404` if unknown, `409` if the
deployment is not running. The browser consumes it with a streaming `fetch` (so the JWT stays in the
`Authorization` header, not the URL).

### `GET /deployments/:id/stats`

Server-Sent Events stream of the running container's resource stats — one `data:` line per sample, a
JSON object `{ cpuPercent, memUsedMb, memLimitMb, memPercent, rxKb, txKb }` derived from `docker stats`.
Proxied from the owning Node Agent's internal `/stats/:containerId`. `404` if unknown, `409` if the
deployment is not running. Consumed with the same streaming `fetch` as logs.

### File management  *(running deployment)*

CRUD over the running container's filesystem, proxied to the owning Node Agent (#108). Each returns
`404` if the deployment is unknown, `409` if it is not running, and `400` (with the container's own
error message) on a bad path or failed operation. Paths are normalised to a traversal-safe absolute
form on the agent, and file operations run as argv arrays (no shell) so a path can't inject.

| Method + path | Purpose |
|---|---|
| `GET /deployments/:id/files?path=/dir` | List a directory — `[{ name, kind: 'file'\|'dir', size }]`, directories first |
| `GET /deployments/:id/files/content?path=/f` | Read a text file — `{ path, content }` |
| `PUT /deployments/:id/files/content` | Create/overwrite a file — body `{ path, content }` → `204` |
| `POST /deployments/:id/files/dir` | Make a directory — body `{ path }` → `201` |
| `POST /deployments/:id/files/rename` | Move/rename — body `{ from, to }` |
| `DELETE /deployments/:id/files?path=/f` | Delete a file or directory (recursive) → `204` |

### Managed databases  *(running deployment)*

Each database is its own engine container the owning Node Agent starts, with credentials the Orchestrator
generates and records (#109). `404` if the deployment is unknown, `409` if it is not running, `400` on a
bad engine, `502` if provisioning on the agent fails.

| Method + path | Purpose |
|---|---|
| `GET /deployments/:id/databases` | List the server's databases |
| `POST /deployments/:id/databases` | Provision one — body `{ engine: 'mysql'\|'mariadb'\|'postgres' }` → `201` with `{ name, username, password, host, port, … }` |
| `DELETE /deployments/:id/databases/:dbId` | Stop + remove the database container and drop the record → `204` |

### Backups  *(running deployment)*

A backup is a tar snapshot of the server's data path (default `/data`), stored on the owning node and
restorable back into the container (#110). `404` if the deployment/backup is unknown, `409` if it is
not running, `502` if the node operation fails.

| Method + path | Purpose |
|---|---|
| `GET /deployments/:id/backups` | List the server's backups (newest first) — `{ name, path, sizeBytes, createdAt, … }` |
| `POST /deployments/:id/backups` | Snapshot the data path → `201` with the backup record |
| `POST /deployments/:id/backups/:backupId/restore` | Extract the snapshot back into the running container |
| `DELETE /deployments/:id/backups/:backupId` | Delete the stored tar and drop the record → `204` |

### Schedules

Recurring tasks the Orchestrator runs on a 5-field cron (minute hour day-of-month month day-of-week, UTC);
actions are `restart` or `backup` (#111). The scheduler polls once a minute. `404` if the deployment/schedule
is unknown, `400` on a bad cron or action.

| Method + path | Purpose |
|---|---|
| `GET /deployments/:id/schedules` | List the server's schedules |
| `POST /deployments/:id/schedules` | Create one — body `{ name, cron, action }` → `201` |
| `PATCH /deployments/:id/schedules/:sid` | Update fields (e.g. `{ enabled: false }` to pause) |
| `POST /deployments/:id/schedules/:sid/run` | Run the schedule's action immediately |
| `DELETE /deployments/:id/schedules/:sid` | Remove the schedule → `204` |

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

### `POST /nodes`

Register (or relabel) a node's metadata (#113) — body `{ id?, name?, location? }`. `id` is generated when
omitted. The node reads **offline** until an agent started with `NODE_ID=<id>` heartbeats in; its
CPU/RAM/disk are then reported automatically and never overwrite the name/location. `201` with the node.

### `DELETE /nodes/:id`

Deregister a node (remove its record; detaches it from any deployments). `409` if it still hosts a
running/pending deployment, otherwise `204`. The machine itself is untouched.

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
