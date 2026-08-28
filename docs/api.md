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

`status` ∈ `healthy | degraded | offline` derived from last-seen age.

The response also carries `deadLetters` (#243): `{ status: 'empty' | 'messages-waiting' | 'unknown',
depth }`. Consumers `nack` without requeue on failure, so a message that cannot be processed lands in
`finvault.events.dlq` — which nothing read and nothing reported on, meaning events could pile up
unnoticed indefinitely. The depth is read passively (`checkQueue` consumes nothing), and a broker that
cannot be asked reports `unknown` rather than `0`: not knowing and knowing nothing failed are
different claims, and only one of them is safe to make without looking. `uptimePercent` (#165) is the
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
password. `400` when either field is missing.

**Rate limited (#225)** per address *and* per account: the first stops one machine walking a password
list, the second stops a botnet spreading the same list across many addresses, and neither alone is
enough. Only failures count and a success clears the count, so normal use never meets the limit. A
locked-out attempt answers **exactly the same 401** as a wrong password — a distinct "account locked"
reply would confirm the account exists and is worth attacking — with a `Retry-After` header.
Configure with `LOGIN_MAX_ATTEMPTS` (10), `LOGIN_WINDOW_MS` and `LOGIN_LOCKOUT_MS` (15 min each).

Every successful login creates a **session** (#227) and the token names it. Send the token as `Authorization: Bearer <jwt>` on
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

### `POST /users/:id/password`  *(platform administrators)*

Set somebody's password without knowing the old one (#226) — the community edition's answer to a
forgotten one, since there is no mail server to assume and accounts are created by an administrator
anyway. Body `{ "newPassword": "…" }` → `204`.

Two rules make this safe to give an `admin` rather than only an `owner`:

- **You cannot reset an account that outranks you** (`403`), or any administrator an owner appoints
  could lock the owner out and take the installation. Admin-resets-admin is allowed; they already hold
  the same power, and refusing it makes the panel useless the moment one of two admins forgets a
  password.
- **Every session of that account ends** (#227). A reset is what you do when you suspect somebody else
  is in the account, so leaving their existing token working would defeat the exercise.

`400` on a password that fails the usual rules, `404` for an unknown account.

### `GET /me/sessions` · `POST /auth/logout` · `DELETE /me/sessions/:id` · `DELETE /me/sessions`

Where this account is signed in, and how to stop being (#227).

A JWT is stateless, so before this a token stayed valid until it expired no matter what happened to
the account behind it: signing out cleared it in the browser and nothing else, and there was no way to
end somebody else's session. A token now names a session row, and `requireAuth` checks that row still
exists — one indexed read per request, which is the price of the answer being true.

- `GET /me/sessions` lists your own, each flagged `current` so you can tell which is you.
- `POST /auth/logout` ends the session making the request; the token stops working immediately.
- `DELETE /me/sessions/:id` ends one other — the "that wasn't me" button. A session that is not yours
  answers `404`, not `403`, so ids cannot be probed (the same rule as servers, #175).
- `DELETE /me/sessions` ends every session but the current one.

Changing your password ends every **other** session, since that is how you respond to thinking
somebody else has it — and leaves the one that made the change signed in, because being logged out of
the page you just used is a punishment for doing the right thing. A token that names no session at all
is refused: it cannot be revoked, which is the thing this replaced.

### `GET /me/totp` · `POST /me/totp` · `POST /me/totp/verify` · `DELETE /me/totp`

Two-factor authentication (#229), TOTP with recovery codes.

| Method + path | Purpose |
|---|---|
| `GET /me/totp` | `{ enabled, enabledAt, recoveryCodesRemaining }` |
| `POST /me/totp` | Begin enrolment → `201 { secret, otpauthUrl }`. Nothing is enforced yet |
| `POST /me/totp/verify` | Body `{ code }` → `201 { recoveryCodes, token }` — the codes are shown once, and the token replaces the one that predates the factor |
| `DELETE /me/totp` | Body `{ password }` → `204`. `409` where the installation requires 2FA |

`POST /auth/login` then takes `{ email, password, code }`, where `code` is either a six-digit TOTP
code or one of the recovery codes (spent on use). Without it the reply is `401 { totpRequired: true }`
— which does confirm the password was right, unavoidably, since the person has to be told to reach for
their phone; it is only ever returned to someone who already holds it. A missing or wrong code counts
as a failed attempt against the login limiter (#225).

With `REQUIRE_TOTP=true`, an un-enrolled account still signs in — the reply carries
`mustEnrolTotp: true` — but every route except `/me`, `/me/totp*` and `/auth/logout` answers
`403 { enrolmentRequired: true }` until enrolment finishes. Refusing the login instead would lock out
everyone, the only administrator included, the moment the flag was turned on. API tokens are exempt:
one was created by somebody who had already satisfied the requirement. A token cannot enrol, disenrol,
or mint another token.

### `GET /me/tokens` · `POST /me/tokens` · `DELETE /me/tokens/:id`

API tokens for scripts and CI (#228). Automating anything used to mean storing a person's password in
a script — a credential that opens the whole account, is indistinguishable from that person in a log,
and cannot be withdrawn without locking them out too.

A token is presented exactly like a JWT, as `Authorization: Bearer nxi_…`. It authenticates as the
account that owns it, so per-server roles resolve exactly as they would for that person.

| Method + path | Purpose |
|---|---|
| `GET /me/tokens` | Your tokens: name, scopes, created, last used, expiry. Never the secret or its digest |
| `POST /me/tokens` | Mint one — body `{ name, scopes?, expiresAt? }` → `201` **including `secret`, the only time it is ever returned** |
| `DELETE /me/tokens/:id` | Revoke → `204`, effective on the very next request |

`scopes` is an array of `write` and/or `admin`:

- **Reading is always allowed**; anything that changes state needs `write`. The rule is by HTTP
  method, not by a table of paths — a path table is a second description of the API that has to be
  kept in step with the first, and the day it falls behind is the day a new route is unscoped, only
  for token callers.
- **`admin` is separate** from the account's platform role. An administrator's CI token that deploys
  should not also be able to create accounts, and whoever pastes it into a pipeline usually has no
  idea it could.
- A scope only ever narrows. A token can never do something its account cannot.

Other rules worth stating:

- **The secret is shown once.** Only its SHA-256 digest is stored, so a leaked database yields nothing
  that can be presented at the door. (SHA-256, not bcrypt: the secret is 256 random bits, so there is
  nothing to brute-force, and this runs on every request.)
- **A token cannot mint tokens** (`403`) — one that could would not really be revocable, since its
  offspring would outlive it.
- **`expiresAt`** is optional; a token past it is refused without anyone deleting the row. A timestamp
  already in the past is `400`.
- Somebody else's token answers `404`, not `403`, so ids cannot be probed.
- The token dies with its account, as a session does.
- **The interactive terminal WebSocket does not accept API tokens** — it opens a root shell, the
  handshake is a `GET`, and a script that needs to run a command has `POST /deployments/:id/exec`.

### `GET /users` · `POST /users`  *(platform administrators)*

List accounts, and create one — the way people get access in the community edition. `POST` takes
`{ email, password, displayName?, platformRole? }` and returns `201`. Both return `403` for
non-administrators.

### `GET /eggs`

The catalogue the panel builds its form from: for each egg, the image, ports, data path and the
variables a person may set, with kind, default, help text and validation.

A `version` variable's `options` are **filled in when this is served** (#311) — the game versions come
from Mojang's manifest, cached, with a baked fallback when the orchestrator has no internet. They are
suggestions: a version is validated by *shape*, never against that list, so a stale or cold cache
cannot refuse a version the image would happily install.

A variable may carry `showWhen: { key, equals[] }`, meaning it only applies for certain answers to
another variable — `NEOFORGE_VERSION` only to `TYPE=NEOFORGE`. A variable that does not apply is not
asked for **and not sent to the container**: irrelevant environment is noise at best, and where two
mod loaders read near-identical names it is a way to install the wrong one.

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

**Ports carry their protocol (#313).** The container side of a mapping may be written in Docker's own
notation — `"2456": "2456/udp"`, or `"27015/tcp+udp"` for a port a game needs on both. A bare number
means TCP, exactly as before, so existing deployments are untouched. This matters more than it looks:
Docker also defaults to TCP, so publishing a UDP game as TCP publishes nothing usable — the container
runs, the panel shows it healthy, and nobody can connect.

**Resource limits accept either unit (#275).** `ramMb` and `cpuCores` (fractional allowed) set an
absolute amount; `ramPercent` and `cpuPercent` set a share of the node. The absolute value wins when
both are present — it is the more specific instruction, and it keeps meaning the same if the server is
ever re-placed onto a node of a different size, which a percentage does not.

`name` and `dockerImage` are required; the rest are optional and stored with the server config (#106) so
a re-start reuses them. The limits ride on `server.start` and the Node Agent enforces them on the
container — RAM/CPU caps, swap, block-I/O weight, restart policy and the OOM killer (#107).

**From an egg (#231):** send `eggId` and `eggValues` instead of `dockerImage`/`env`. The egg decides
the image, the environment and the default ports; anything the caller sends for those is **ignored,
not merged** — an egg that could be overridden would be a suggestion rather than a recipe, and you
could run any image at all while still being labelled a Minecraft server. Unknown variables are
dropped rather than passed through as arbitrary container environment, missing ones take their
default, and the egg's `fixedEnv` (such as Minecraft's `EULA=TRUE`) is applied last. `ports` is still
honoured, as the host-side override. `400` for an unknown egg or an invalid answer, with the message
naming the field as the person saw it ("Player slots must be a whole number").

**Importing an existing directory (#268):** send `dataPath` alongside an egg. The directory is
bind-mounted at the egg's `dataPath`, so the server runs against files that are already on the node
— an existing world, config and all.

This is **platform-administrator only**, and it is the one place the panel hands out a host-escape
primitive: a bind mount of the wrong directory into a container the user has a root shell in is the
machine. So the *node* decides, not the orchestrator, which cannot see that filesystem: the path
must resolve inside the node's `IMPORT_ROOT` (unset = importing is off), containment is checked on
the **resolved real path** after symlinks, and the agent re-checks at start rather than trusting the
event. `403` for a non-administrator, `400` when the node refuses the path or when no egg says where
to mount it.

**Memory (#271, #308):** an egg may name the variable that is its JVM heap. The container's `Memory`
cap is `ramPercent%` of the node's total RAM and the kernel enforces it absolutely, while the JVM
*commits* its heap — so a heap that does not fit is a container killed mid-save, not a slow server.

**The heap is derived from the cap unless the request names one.** Asking for both is asking the same
question twice in two different units, and the defaults collided: 50% of a 4 GB node is a 2048 MB cap
against a `2G` heap default that needs ~2560 MB, so an untouched request was refused on a small node
and accepted on a large one. Omitting the heap variable from `eggValues` yields the largest heap that
leaves the JVM its overhead; sending one keeps that value. Note *omitting*, not blanking — an egg
reads a blank value as "use my default", which is the constant this replaced.

Deriving is skipped where there is nothing honest to derive from: an uncapped server, or a node that
has never reported its RAM. A cap too small for any heap at all is refused with `400` saying exactly
that, rather than suggesting a 0 MB heap.

A create or edit whose heap plus the JVM's own overhead (a quarter of the heap, floor 512 MB) exceeds
the cap is still refused with `400`, and the message is in MB: a percentage of a node you have not
measured is not a number anyone can act on. The check is silent when anything is unknown — no cap, a
node that has not reported its RAM, or a value that is not a memory size.

`nodeId` pins the server to a specific node (#254); omit it to let the Orchestrator place it on the
least-loaded healthy node. A pin is honoured or refused, never silently reassigned — `400` for an
unknown node, `409` for one that is not healthy.

Responses: `201` with the deployment (including its event trail), `400` on missing fields, `503` when no healthy
node is available. In the hosted edition, `409` when the plan's `maxServers` quota is reached (checked
against the Billing Bridge; community edition never limits). On success the Orchestrator emits
`infra.server.start` for the chosen node.

Each node also carries a `capacity` block (#275) with **three distinct numbers**, because they answer
three different questions:

- `ramTotalMb` / `cpuCoresTotal` — the hardware.
- `ramCommittedMb` / `cpuCoresCommitted` — the sum of the caps already handed to servers placed here.
- `ramUsedMb` / `cpuUsedPercent` — what is being consumed right now.

`ramAvailableMb` / `cpuCoresAvailable` derive from **committed**, never from usage: four idle servers
capped at a quarter of the RAM each leave nothing to give away, and a node running nothing reports
most of its memory used because Linux spends spare RAM on page cache. `overCommitted` says when a node
has been promised more than it has, which is possible and worth knowing.

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

One page of the deployments the caller may see, newest first, each joined with its config name/image,
current status (`pending | running | stopped | crashed | failed`) and the caller's `role` on it.

**Answers an envelope, not an array** (#237):

```
{ "items": [ … ], "total": 137, "limit": 25, "offset": 0 }
```

`total` is the count *after* filtering, so a caller can always tell there is more. A bare page of rows
cannot say that, and a list that silently returns the first 25 of 200 is worse than the unbounded one
it replaced — which is why this is an envelope rather than a truncated array.

| Query | Effect |
|---|---|
| `q` | Case-insensitive substring of the name |
| `status` | Exact status |
| `nodeId` | Exact node id, or `unassigned` for servers that landed nowhere |
| `ownerId` | Exact owner account id |
| `limit` | Page size — default `25`, capped at `200`, applied whether or not it is given |
| `offset` | Where the page starts |

Filters combine as "and". An unrecognised parameter is ignored rather than refused, so a stale
bookmark still shows somebody their servers. Ordering is total (created time, then id), so paging
never shows one row twice and hides another.

Filtering happens after the caller's visibility is resolved, so it can never widen what they see.

### `GET /deployments/:id`

A single deployment with its full `events` audit trail **and the runtime configuration it was created
with** — `ports`, `env`, `resourceLimits` and `autoRestart` — which the panel's Network and Startup
tabs render. `404` if unknown (also when the caller has no access, so ids cannot be probed).

### `GET /placement`

Which node an automatically-placed server would land on right now → `{ "nodeId": "node-a" }`, or
`{ "nodeId": null }` when nothing is eligible (#309).

A **preview, not a reservation**: placement is decided again at creation, and the fleet can move in
between. It exists so the panel can turn "50% of RAM" into a number of megabytes without
reimplementing `selectNode` — its own version filtered neither unhealthy nor draining nodes, so with
two or more nodes it could describe a machine the server was never going to land on.

### `PATCH /deployments/:id`

Change an existing server's configuration (#220). Body may carry any of `name`, `dockerImage`,
`ports`, `env`, `resourceLimits`, `autoRestart`; **an omitted field is left alone**, so a partial
edit never blanks the rest. Requires `server.edit` (server admin and up — an operator may run a
server but not redefine it).

For a server built from an egg with a heap (#308), the heap is **re-derived from the memory limit on
every write unless the request names one**. So raising the memory limit raises the heap with it,
rather than being refused for a heap the person never chose — and an override has to be re-sent to
survive, which keeps the intent in the request instead of in hidden state nobody can see or correct.

A server created from an egg is edited **through that egg** (#272): send `eggValues` instead of
`env`, and the same rules apply as at creation — unknown keys dropped, values validated by the name
the person saw, `fixedEnv` untouchable. Answers are merged over what is stored, so an untouched
variable keeps its value rather than reverting to the egg's default. The heap check (#271) runs on
edit as well, since raising the heap is exactly how someone would break it later.

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

### `POST /deployments/:id/transfer` (#230)

Hand a server to another account. Body `{ email, retainRole? }`, where `retainRole` ∈
`viewer | operator | admin` or `null`/omitted for "the previous owner keeps nothing". Returns
`{ deploymentId, ownerId, retainedRole }`.

Requires `server.transfer`, which only the owner (or a platform administrator) holds: a server admin
who could transfer could hand the server to themselves, which is the one thing their role withholds.

- The recipient **must already have an account** (`404` otherwise). A per-server invitation may wait
  for someone to sign up because it grants nothing meanwhile; a server with a pending owner is the
  orphan this route exists to prevent.
- Transferring to the current owner is `400`; asking the previous owner to retain `owner` is `400`,
  since ownership is never a grant.
- A share the recipient already held is dropped — they own the server now, and a leftover share would
  read as though revoking it could take their access away.
- If the previous owner's account no longer exists, the transfer still works (that is the case worth
  rescuing) but asking for a retained role is `409` rather than silently ignored.
- Recorded on the deployment's audit trail as `ownership-transferred`.
- Hosted edition: usage accrues to whoever owns the server, so future charges follow the new owner.

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
