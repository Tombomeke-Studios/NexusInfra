# API

HTTP endpoints and event contracts. Updated with every endpoint or request/response change.

---

## Control Room (`:9000`)

### `GET /health`

Liveness probe. Every service exposes one with the same shape.

```json
{ "service": "control-room", "status": "healthy", "version": "0.1.0", "edition": "community", "uptimeSec": 123 }
```

`version` is baked into the image by the release build (`APP_VERSION`), reading `0.0.0-dev` outside
one. `edition` is the service's resolved `NEXUS_EDITION` — check it here when billing behaves
unexpectedly in a hosted stack, since a service that never received the variable silently runs as
`community` (#173).

### `GET /status`

Live monitoring snapshot of every heartbeat source seen on the bus.

```json
{
  "monitored": [
    { "source": "control-room", "status": "healthy", "lastSeenMsAgo": 412, "uptimePercent": 99.87 }
  ],
  "thresholds": { "degradedMs": 3000, "offlineMs": 10000 }
}
```

`status` ∈ `healthy | degraded | offline` derived from last-seen age. `uptimePercent` (#165) is the
share of observed time the source was healthy, since it was first seen.

### `GET /uptime`

Reliability detail per source: cumulative uptime plus recent status transitions.

```json
{
  "sources": [
    {
      "source": "orchestrator",
      "status": "healthy",
      "lastSeenMsAgo": 300,
      "uptimePercent": 96.5,
      "firstSeen": 1800000000000,
      "observedMs": 200000,
      "healthyMs": 193000,
      "transitions": [{ "from": "healthy", "to": "degraded", "at": 1800000100000 }]
    }
  ],
  "thresholds": { "degradedMs": 3000, "offlineMs": 10000 }
}
```

Transitions are oldest-first and capped per source (ring buffer) so memory stays bounded. State is
in-memory, so it resets when the Control Room restarts — persisted history is a later phase.

---

## Orchestrator (`:9200`)

The deployment control plane. Creating a deployment selects the least-loaded healthy node, records
the deployment, and commands the Node Agent to start the container. `GET /health` returns the usual
liveness shape. All responses are JSON.

> Auth: every route below requires a Bearer token from `POST /auth/login`; requests without a valid
> token get `401`. Identity is local to the panel (#174) — see [security.md](security.md). The
> FinVault-issued JWT validated at the API Gateway remains the long-term direction (#20/#17).
>
> **Authorization (#175):** every `/deployments/:id/*` route also requires a sufficient role on that
> specific server. A caller with **no** access gets `404` (not `403`) so server ids cannot be probed
> for existence; a caller who may see the server but not perform the action gets `403`. Roles, from
> least to most: `viewer` · `operator` · `admin` · `owner` — the table in
> [security.md](security.md#authorization--who-may-do-what-to-a-server-175) is authoritative.
> `GET /deployments` is scoped to what the caller may see and each row carries their `role`.

### `GET /config`  *(public)*

Runtime config the dashboard reads before login to decide whether billing UI renders (#144).
Contains no sensitive data.

```json
{ "edition": "community" }
```

`edition` ∈ `community | hosted`, resolved from the service's `NEXUS_EDITION` (default `community`).

### `POST /auth/login`  *(public)*

Exchange account credentials for a signed JWT (12h TTL, signed with `JWT_SECRET`).

```json
// request
{ "email": "you@example.com", "password": "…" }
// 200 response
{ "token": "<jwt>" }
```

`401` on bad credentials — deliberately the same response for an unknown account as for a wrong
password. `400` when either field is missing. Send the token as `Authorization: Bearer <jwt>` on
every other call. An install that predates accounts may also sign in with its legacy username.

The first administrator is seeded from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first start.

### `POST /auth/register`  *(public — hosted edition only)*

Create an account and receive a token for it, as a hosting customer would.

```json
// request
{ "email": "you@example.com", "password": "…", "displayName": "Ada" }
// 201 response
{ "token": "<jwt>", "user": { "id": "…", "email": "you@example.com", "platformRole": "user" } }
```

`403` in the community edition, where accounts are created by an administrator instead. `409` when
the email is taken, `400` on an invalid email or a password under 8 characters. A `platformRole` in
the request is ignored — registration never grants privilege.

### `GET /me` · `POST /me/password`

The signed-in account (never including any credential material), and a password change that requires
the current password: `{ "currentPassword": "…", "newPassword": "…" }` → `204`, `401` if the current
password is wrong.

### `GET /users` · `POST /users`  *(platform administrators)*

List accounts, and create one — the way people get access in the community edition. `POST` takes
`{ email, password, displayName?, platformRole? }` and returns `201`. Both return `403` for
non-administrators.

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
  "nodeId": "node-rack-1",
  "resourceLimits": { "cpuPercent": 50, "ramPercent": 50, "diskPercent": 50, "swapPercent": 0, "ioPriority": "normal", "restartPolicy": "on-failure", "oomKill": false }
}
```

`name` and `dockerImage` are required; the rest are optional and stored with the server config (#106) so
a re-start reuses them. The limits ride on `server.start` and the Node Agent enforces them on the
container — RAM/CPU caps, swap, block-I/O weight, restart policy and the OOM killer (#107).

`nodeId` pins the server to a specific node (#254); omit it to let the Orchestrator place it on the
least-loaded healthy node. A pin is honoured or refused, never silently reassigned — `400` for an
unknown node, `409` for one that is not healthy.

Responses: `201` with the deployment (including its event trail), `400` on missing fields, `503` when no healthy
node is available. In the hosted edition, `409` when the plan's `maxServers` quota is reached (checked
against the Billing Bridge; community edition never limits). On success the Orchestrator emits
`infra.server.start` for the chosen node.

Nodes report `cpuCores` once their agent has beaten in (#261); it is `null` until then, and the
panel shows nothing rather than a guess. `GET /deployments` rows carry their `resourceLimits`, which
the Overview sums per node to show what is genuinely committed there.

### `PATCH /nodes/:id/maintenance`  *(platform administrators)*

Drain a node, or return it to the placement pool (#258). Body `{ "maintenance": true | false }` →
`200` with the node and its health.

Maintenance means **keep running what you have, take nothing new**: the Orchestrator excludes the
node from placement, and a request that pins a server to it (see `nodeId` above) is refused with
`409`. It deliberately does **not** stop the deployments already there — draining and shutting down
are separate decisions. Heartbeats never clear the flag, so a node stays drained until somebody
lifts it. `400` if the body is not a boolean, `403` for non-administrators, `404` for an unknown node.

### `GET /deployments`

List all deployments (newest first), each joined with its config name/image and current status
(`pending | running | stopped | crashed | failed`).

### `GET /deployments/:id`

A single deployment with its full `events` audit trail **and the runtime configuration it was created
with** — `ports`, `env`, `resourceLimits` and `autoRestart` — which the panel's Network and Startup
tabs render. `404` if unknown (also when the caller has no access, so ids cannot be probed).

### `PATCH /deployments/:id`

Change an existing server's configuration (#220). Body may carry any of `name`, `dockerImage`,
`ports`, `env`, `resourceLimits`, `autoRestart`; **an omitted field is left alone**, so a partial
edit never blanks the rest. Requires `server.edit` (server admin and up — an operator may run a
server but not redefine it).

The change is stored and **nothing is restarted**: it applies the next time the server starts. A
settings form that silently bounced a running server would be a worse surprise than one that waits.
Recorded in the audit trail as `config-updated`. `200` with the updated deployment, `400` on an
empty name/image or a non-object `ports`/`env`/`resourceLimits`, `403` without the permission.

### `GET /deployments/:id/events`

The server's audit trail, **newest first** (#223) — creation, placement, start/stop/kill requests,
crashes, restores. Written since the beginning and, until now, never readable: `?limit=` (default
50, max 200) and `?offset=` paginate it, because a long-lived server accumulates these
indefinitely. Requires `server.view`.

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
| `PUT /deployments/:id/files/content` | Create/overwrite a text file — body `{ path, content }` → `204` |
| `PUT /deployments/:id/files/binary?path=/f` | Upload raw bytes — `Content-Type: application/octet-stream`, body is the file → `204`. The binary-safe path (#263): text encoding destroys any byte that is not valid UTF-8, so uploads never travel as JSON. Capped by `MAX_UPLOAD_BYTES` (default `64mb`), over which the request is refused |
| `POST /deployments/:id/files/dir` | Make a directory — body `{ path }` → `201` |
| `POST /deployments/:id/files/rename` | Move/rename — body `{ from, to }` |
| `DELETE /deployments/:id/files?path=/f` | Delete a file or directory (recursive) → `204` |

### `POST /deployments/:id/exec`  *(running deployment)*

Run a one-shot shell command in the running container (#68) — body `{ command }`, executed as `sh -c`.
Returns `{ stdout, stderr, exitCode }`. Proxied to the owning Node Agent's internal `/exec/:containerId`.
`404` if unknown, `409` if not running, `400` on an empty command or exec failure. Each call is a fresh
shell (stateless — a `cd` doesn't persist); a full interactive PTY is a later slice (#71).

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

### Subusers

Per-server access control (#112) — who may access a server, by email, with a role (`admin` or `viewer`).
This is the **management** layer; enforcement arrives with real multi-user login (the FinVault-JWT
gateway, #20). `404` if the deployment/subuser is unknown, `400` on a bad email/role.

| Method + path | Purpose |
|---|---|
| `GET /deployments/:id/subusers` | Who has access, each with their role and `pending`/`active` state |
| `POST /deployments/:id/subusers` | Invite by email — body `{ email, role }`, re-inviting updates the role → `201` |
| `PATCH /deployments/:id/subusers/:sid` | Change someone's role — body `{ role }` |
| `DELETE /deployments/:id/subusers/:sid` | Revoke access → `204`, effective on the next request |

`role` ∈ `viewer | operator | admin` — ownership is never grantable, so `owner` is rejected with
`400`. All four require the `subuser.manage` permission, so an operator can neither see nor change
who else has access. Inviting yourself is refused.

Inviting an address that already has an account binds and activates it immediately. Otherwise the
invitation is stored **pending** and grants nothing until that person registers or signs in with
that address, at which point it is claimed automatically (#176).

### `POST /deployments/:id/stop`

Request a running deployment be stopped — emits `infra.server.stop`; the agent stops **and removes**
the container (freeing its name and host ports). `202` while stopping, `404` if unknown, `409` if the
deployment is not running.

### `POST /deployments/:id/kill`

Force-terminate a running deployment (#253) — emits `infra.server.kill`; the agent sends SIGKILL and
removes the container. For a container that ignores a graceful stop; unsaved state is lost. Requires
the same `control.stop` permission as a stop, but is audited separately as `kill-requested`. `202`
while killing, `404` if unknown, `409` if the deployment is not running.

### `POST /deployments/:id/restart`

Request a running deployment be restarted — emits `infra.server.restart` with the stored container id;
the agent restarts the container and reports `server.started`. `202` while restarting, `404` if
unknown, `409` if the deployment is not running.

### `WS /deployments/:id/terminal`

Interactive terminal (#71) — a WebSocket that opens a TTY shell (`sh`) in the running container. The JWT
rides as a `?token=<jwt>` query param (browsers can't set WS headers); `?cols=&rows=` set the initial
size. The Orchestrator validates the token, resolves the owning container, and pipes the socket to the
Node Agent's internal `/terminal/:containerId` WS. Client→server frames are JSON (`{type:"input",data}`
/ `{type:"resize",cols,rows}`); server→client is raw terminal output. The socket closes on invalid
token, unknown/not-running deployment, or when the shell exits.

### `DELETE /deployments/:id`

Permanently delete a deployment. If it is running, the container is stopped first (emits
`infra.server.stop`); any managed database containers are deprovisioned (best-effort); then the
deployment and all its child records (events, databases, backups, schedules, subusers) are removed.
`204` on success, `404` if unknown.

### `GET /nodes`

Registered nodes with their latest resources and derived `health` (`healthy | degraded | offline`).

### `POST /nodes`

Register (or relabel) a node's metadata (#113) — body `{ id?, name?, location?, agentUrl? }`. `agentUrl`
pins where that node's agent is reachable (#171); normally the node advertises it on its own heartbeat. `id` is generated when
omitted. The node reads **offline** until an agent started with `NODE_ID=<id>` heartbeats in; its
CPU/RAM/disk are then reported automatically and never overwrite the name/location. `201` with the node.

### `DELETE /nodes/:id`

Deregister a node (remove its record; detaches it from any deployments). `409` if it still hosts a
running/pending deployment, otherwise `204`. The machine itself is untouched.

---

### `GET /monitoring`

Surfaces the Control Room's live service/node health to the dashboard (#157) — the panel talks only to
the Orchestrator, which proxies the Control Room's `/status`. Returns `{ monitored: [{ source, status,
lastSeenMsAgo }], reachable }`. If the Control Room is unreachable, `200` with `{ monitored: [],
reachable: false }` so the panel can show it as down rather than erroring.

### Teams (#177)

| Route | Purpose |
|---|---|
| `GET /teams` | Teams the caller owns or belongs to |
| `POST /teams` | Create a team — body `{ name }` → `201`, caller becomes its owner |
| `GET /teams/:id` | The team with its members |
| `DELETE /teams/:id` | Delete it → `204`; its servers are **detached, not deleted** |
| `POST /teams/:id/members` | Add someone — body `{ email, role }` → `201` |
| `PATCH /teams/:id/members/:userId` | Change a member's role — body `{ role }` |
| `DELETE /teams/:id/members/:userId` | Remove a member, or yourself to leave → `204` |
| `PATCH /deployments/:id/team` | Share a server with a team, or detach — body `{ teamId }` (`null` detaches) |

`role` ∈ `viewer | operator | admin`, as for a per-server share. A team the caller doesn't belong to
answers `404`. Only the team owner may add, re-role or remove others (`403` otherwise); anyone may
remove themselves. Adding an address with no account yet is `404` — team membership needs a real
account, since it grants access to every server the team holds. Attaching a server requires
owner-level permission on it and membership of the target team.

### Billing proxy (authenticated) — hosted edition

The dashboard's Billing page (#149) talks only to the Orchestrator, which proxies to the Billing Bridge
and **injects the caller's authenticated userId** from the JWT (the client never sends a user id):

- `GET /billing/wallet` · `GET /billing/usage` · `GET /billing/ledger` · `GET /billing/plan`
- `POST /billing/topup` — body `{ amount }`

Each forwards to the matching Billing Bridge route below for the authenticated user. `502` if the
Billing Bridge is unreachable. These are inert in the community edition (no Billing Bridge running).

## Billing Bridge (`:9300`) — hosted edition only

Usage-based billing for the hosted edition. In the community edition only `GET /health` is served (it
reports the running `edition`); the routes below are mounted only when `NEXUS_EDITION=hosted`. Identity
is the FinVault `userId` (a path param for now; the API Gateway will bind it from the JWT later).

### `GET /billing/:userId/wallet`

The user's prepaid credit balance: `{ userId, balance, currency }` (a zero wallet is created on first read).

### `GET /billing/:userId/usage`

Accrued runtime and projected cost this cycle: `{ hours, cost, plan }`. The plan's monthly free-hour
grant is spent across the user's runtime intervals; billable hours are charged at each server's
resource factor (derived from its CPU/RAM limits).

### `GET /billing/:userId/ledger`

The append-only credit ledger (top-ups + charges), newest first.

### `GET /billing/:userId/plan`

The user's pricing/quota plan (rate, free hours, `maxServers`, `maxDatabases`).

### `GET /billing/:userId/quota?resource=servers|databases&current=N`

Quota check used by the Orchestrator (#148): `{ allowed, limit }` — whether creating one more of
`resource` stays within the plan given the user already has `current`. `400` on a bad resource/count.

### `POST /billing/:userId/topup`

Start a credit top-up funded via FinVault — body `{ amount, currency? }`. Records a **pending** ledger
entry and emits `payment.request` to FinVault; credit is added only on `payment.confirmed`. `202` with
`{ status: "pending", reference, entry }`; `400` on a non-positive amount.

## API Gateway (`:9400`)

The single external entry point (#20). It applies **CORS**, **per-client rate limiting** (token bucket,
per authenticated user or IP), and **JWT validation** on protected routes, then reverse-proxies to the
backend (the Orchestrator, which itself fronts Billing Bridge + Control Room). Public routes (`/auth/*`,
`/config`) skip auth; everything else requires a valid `Authorization: Bearer <jwt>`. The gateway
forwards the token and adds `x-user-id`/`x-forwarded-for` for the backend.

- `GET /health` — the gateway's own liveness (not proxied).
- Any other path → matched by longest prefix and proxied: `401` (missing/invalid token on a protected
  route), `404` (no route), `429` (rate limit exceeded), `502` (backend unreachable), else the backend's
  response verbatim.

The WebSocket proxy for the interactive terminal (#69/#71) is not built yet. The dashboard currently
calls the Orchestrator directly; routing it through the gateway is a follow-up.

## Event contract (bus API)

The full event union is defined in `shared/src/events.ts` — that file is the contract's source of
truth. Summary:

| Event type | Direction | Notes |
|---|---|---|
| `heartbeat.service` / `heartbeat.node` | any → control-room | 1s pulse; node variant carries a resources block |
| `server.start` / `server.stopped` / `server.started` / `server.crashed` | orchestrator ↔ node-agent | container lifecycle |
| `deployment.created` / `deployment.failed` | orchestrator → bus | audit; `deployment.created` also carries `resourceLimits` for billing tracking |
| `payment.request` | billing-bridge → FinVault | credit top-up charge; payload shape matches FinVault's `payment.request` exactly |
| `payment.confirmed` / `payment.failed` | FinVault → billing-bridge | consumed to add / mark-failed a top-up's credit |
| `billing.server.suspend` | billing-bridge → orchestrator | stop a user's servers when credit is exhausted (hosted; NexusInfra-only key) |
| `invoice.generate` | billing-bridge → FinVault | monthly invoice record for a closed cycle (hosted; NexusInfra-only key) |

Envelopes and encryption: see [architecture.md](architecture.md#event-bus). Payload shapes for the
`payment.*` trio must never drift from FinVault's `shared/src/events.ts`.
