# NexusInfra — CLAUDE.md

Infrastructure & server-management platform: TypeScript (Node.js, ESM) backend services + React dashboard
+ Docker-orchestrating node agents. Integrates with FinVault for usage-based billing over RabbitMQ.
This file is **context + rules only** — all tasks and progress live in [TODO.md](TODO.md).

Design source of truth: [`../CONCEPTS/infrastructure-platform/`](../CONCEPTS/infrastructure-platform/)
and [`../CONCEPTS/integration/`](../CONCEPTS/integration/).

---

## 0. Where we are — read this first

**One codebase, two products.** `NEXUS_EDITION=community|hosted` (default `community`) decides which
one a running stack is. Never fork the two apart; anything edition-specific goes behind that flag.

| | **Community** | **Hosted** |
|---|---|---|
| Who runs it | Anyone self-hosting the panel on their own machines | The public/portfolio instance |
| Billing & FinVault | off | on (Billing Bridge, credit wallet, plan quotas) |
| Accounts | created by an administrator | customers register themselves |

**Current phase: 6 — multi-user sharing + two shippable releases** ([TODO.md](TODO.md) has the
checklist; every item carries its issue ref). The order matters and each step is one branch + PR:

1. ~~Edition flag reaches every service (#173)~~ — done.
2. **Accounts (#174)** — real users, local identity behind an `AuthProvider` seam.
3. ~~Access control (#175)~~ — done. Every server route declares a permission; no access answers 404.
4. ~~Subuser invites bound to real accounts (#176)~~ · ~~teams (#177)~~ · ~~role-aware UI (#178)~~ — done.
5. ~~Release pipeline: per-edition images + `deploy/{community,hosted}` bundles (#179)~~ — done.

**Phase 6 is complete.** Tag `vX.Y.Z` on `main` to cut a release; see [docs/deployment.md](docs/deployment.md).

**Vocabulary** — keep these distinct, they are two different things:
- **Platform role** (`owner` / `admin` / `user`) — panel-wide standing: who may manage nodes and
  accounts. Rides on the JWT.
- **Server role** (`owner` / `admin` / `operator` / `viewer`) — what one person may do to one
  server, granted directly or through a team. Resolved per request, never stored on the token.

---

## 1. Language policy

**Everything is written in English** so the project is uniform end to end:

- UI copy, labels, toasts, error messages
- Code comments, identifiers, log output
- Documentation (`docs/`, README, this file), commit messages, PR titles/bodies, test names

## 2. Branch strategy — three tiers

```
feature/<topic>  →  dev  →  staging  →  main
```

| Branch | Purpose | Who merges into it |
|---|---|---|
| `feature/<topic>` | Active development — one logical topic per branch | You, via PR |
| `dev` | Integration — always CI-green, shared ground truth | PRs from feature branches |
| `staging` | Production preparation — smoke tests, env hardening | PR from `dev` once a milestone is complete |
| `main` | Production — only ever updated from `staging` | PR from `staging` after sign-off |

**Rules:**
- A feature branch **never** targets `main` or `staging` directly.
- `staging` only receives merges from `dev` — never individual feature branches.
- `main` only receives merges from `staging` — never from `dev` or feature branches.
- **`main` and `staging` are permanent branches — never delete them.**
- A red CI on `dev` is everyone's problem — fix it before opening new PRs.
- The GitHub **default branch is `dev`**: new PRs target it by default.

## 2a. GitHub issues — every task is a trackable issue

Tasks live in two places that must stay in sync:

- **TODO.md** — the working checklist, grouped per branch (single source of truth for *progress*)
- **GitHub issues** — the trackable mirror of every open TODO item (single source of truth for *linking*: PRs, commits, discussion)

**Trigger table — when X happens, the agent does Y, immediately and unprompted:**

| Moment | Action |
|---|---|
| You add an actionable item to TODO.md | Create its GitHub issue and put the `(#N)` ref on the TODO line |
| You promote a backlog group to `feature/<topic>` | Verify every item in it has an issue; create any missing ones first |
| You discover a bug while working | Issue immediately (`type:bug`), then decide: fix now or backlog |
| You open a PR | One `Closes #N` line **per completed issue, each on its own line** in the PR body |
| The PR merges | Verify the issues auto-closed; move the group to Done in TODO.md |

**Rules:**

1. **Every actionable TODO item gets a GitHub issue** — at the latest when its backlog
   group is promoted to an active `feature/<topic>` group; bugs get one immediately.
   Create with `gh issue create --title "..." --body "..." --label type:<y>`.
2. **Title** = the TODO line, imperative. **Body** = context, acceptance criteria, affected files.
3. **Labels:** one `type:*` label (bug/feature/refactor/test/docs/ci).
4. **TODO.md items carry their issue ref:** `- [ ] Fix X (#12)`.
5. **PR bodies close their issues:** each completed issue must appear as its own `Closes #N` line — never comma-separated on one line (`Closes #1, #2` only auto-links the first in GitHub's Development panel).
6. An issue is only ever closed by a merged PR — or manually with a comment.
7. Open issues are the **backlog**, not a failure signal.

## 2b. The iteration loop (follow for every unit of work)

A "unit" = one function, feature, fix, or refactor — the smallest shippable slice.

1. **Pick** the next unticked item from the active branch group in TODO.md.
2. **Read context** before touching code: the codebase map below + the matching doc.
3. **Write tests first** (TDD): write or outline tests for the expected behavior before implementing.
4. **Implement** the slice. Match surrounding style; reuse existing patterns.
5. **Run tests** and verify they pass.
6. **Document it**: update the affected doc(s); new files also update the codebase map in this file.
7. **Tick TODO.md** for the item (add follow-up items you discovered to the backlog).
8. **Commit** — one small commit containing the code + tests + docs + TODO tick.
9. **Push** — `git push` after every commit.
10. Repeat 1–9 until the branch group is fully ticked.

**Branch finish protocol** (after the last item on a feature branch):
1. Run CI locally: `npm run build && npm run lint && npm test` — all must pass.
2. Push the final state and open a PR **targeting `dev`**.
3. **Wait for CI to pass on the PR** — a red PR is not done.
4. After merge: move the branch group in TODO.md to the Done section.

**Promoting `dev` → `staging` → `main`:**
1. Open a PR `dev → staging` only when a full milestone is complete. Wait for CI.
2. After merge to `staging`, verify CI passes on staging push.
3. Open a PR `staging → main` only after step 2 is signed off. Wait for CI.
4. After merge to `main`: tag the release (`git tag vX.Y.Z`) and push the tag.
5. **Back-merge `main` into `dev`** with a PR, then sync `staging` from `dev`. Do not skip this.

> **Why step 5 exists.** Merging a promotion PR creates a merge commit **on the target branch** —
> `dev → staging` puts one on `staging`, `staging → main` puts one on `main`. They are born on the
> receiving side and never travel back on their own, so `main` silently drifts ahead of `dev` by two
> commits per release. The code is fine; the history is not, and by the third release `main` was six
> commits ahead of `dev` with an identical working tree.
>
> Check it with `git log --oneline origin/dev..origin/main` — that should be empty once a release is
> finished. `git diff origin/dev origin/main` being empty only tells you no *content* is missing.
>
> A back-merge leaves one small sync commit behind each time. The alternative is to fast-forward the
> lower branches instead (`git push origin main:dev`), which adds no commits at all, but rewrites
> nothing only because the branches are strict ancestors — verify that with
> `git merge-base --is-ancestor origin/dev origin/main` before ever reaching for it.

## 3. Commit rules

- **One logical change per commit.** If the message needs "and", split it.
  Code + its tests + its docs + its TODO tick belong *together* in that commit.
- Never mix refactoring with behavior changes; never mix dependency bumps with code.
- Format: `type(scope): imperative summary` — body explains *why* when non-obvious.
  - **Types:** `feat` `fix` `docs` `chore` `refactor` `test` `ci`
  - **Scopes:** `shared` `control-room` `orchestrator` `agent` `billing` `gateway` `dashboard` `db` `infra` `docs`
  - Examples: `feat(shared): add event envelope with AES-GCM payloads`, `ci(infra): add GitHub Actions workflow`.
- Before every commit: verify tests pass and linting is clean.

## 4. Testing rules

- **Backend (TypeScript):** Vitest, colocated `*.test.ts` files next to source (`shared/src/events.test.ts` pattern).
- **Dashboard (React):** Vitest for unit tests, colocated `*.test.ts(x)` files.
- **New backend logic => unit tests required** (event handlers, node selection, billing calculations).
- **Bug fixes:** when feasible, write the test that catches the bug first (TDD).
- **Integration tests (#242):** `*.integration.test.ts`, run by `npm run test:integration` (never by
  `npm test`) and by CI's `integration` job against a real RabbitMQ and a real Prisma database. Put a
  test there when only the real thing can prove it — a binding, a unique index, a transaction.
- **Wire compatibility with FinVault is test-guarded** — `shared/src/events.test.ts` locks the envelope
  shape and AES-256-GCM layout. Never change these without an equivalent change in FinVault.

## 5. Documentation rules — which doc owns what

**No database code in documentation.** Docs must never contain SQL DDL,
migration snippets, index definitions or column-level schema listings — a
readable schema dump makes it easier for an attacker to map the data model
and hunt for gaps. Describe *what* is stored and *why* in prose (entity-level
relationship diagrams without columns are fine); the schema's source of truth
is the migrations directory.

| You changed... | Update |
|---|---|
| Services, endpoints, event contracts, infra topology | [docs/architecture.md](docs/architecture.md) |
| Auth, secrets, message encryption, security concerns | [docs/security.md](docs/security.md) |
| Docker, CI/CD, deployment | [docs/deployment.md](docs/deployment.md) |
| A service's port, env vars or volumes | **also** [docs/images.md](docs/images.md) — people assemble stacks from it |
| API endpoints, request/response formats, routing keys | [docs/api.md](docs/api.md) |
| Pricing, quotas, the credit wallet, the billing cycle (hosted) | [docs/billing.md](docs/billing.md) |
| New/moved/renamed files, new commands, new gotchas | **This file** (map in section 7) |
| Setup / how-to-run instructions | README.md |
| The installer's behaviour or prompts | [docs/installer.md](docs/installer.md) |
| Tasks, progress, follow-ups | [TODO.md](TODO.md) — and *only* there |
| Product concept / cross-project design decisions | `../CONCEPTS/` (separate repo — commit there separately) |

## 6. Commands

| What | Command (repo root) |
|---|---|
| Install workspace deps | `npm install` |
| Build everything (shared first) | `npm run build` |
| Build/run the CLI | `npm run build --workspace=cli` · `node cli/dist/index.js --help` |
| Run all tests | `npm test` |
| Integration tests (real broker + DB, #242) | `RABBITMQ_URL=amqp://guest:guest@localhost:5672 npm run test:integration` |
| Lint all workspaces | `npm run lint` |
| Dev watch: shared + control-room | `npm run dev` |
| Start stack (RabbitMQ + services, Docker) | `docker-compose up` |
| Start only the broker | `docker-compose up rabbitmq` |
| Run the dashboard (dev) | `npm --workspace dashboard run dev` (http://localhost:5173) |
| RabbitMQ management UI | http://localhost:15672 (guest/guest) |
| Control Room health / status | http://localhost:9000/health · /status |
| Orchestrator API | http://localhost:9200 (sign in as `ADMIN_EMAIL` / `ADMIN_PASSWORD`) |
| Billing Bridge (hosted only) | http://localhost:9300/health · billing routes when `NEXUS_EDITION=hosted` |
| API Gateway | http://localhost:9400 (fronts the orchestrator; JWT + rate limit) |

## 7. Codebase map — where is what

### shared (event contract + messaging)
| Path | Contents |
|---|---|
| `shared/src/events.ts` | Event union, envelope, AES-256-GCM payload encryption — **wire-compatible with FinVault** (same algorithm, KDF salt, envelope shape) |
| `shared/src/rabbitmq.ts` | Connect/publish/consume helpers targeting the shared `finvault.events` topic exchange + `finvault.events.dlx` |
| `shared/src/heartbeat.ts` | `startHeartbeat(name)` (service pulse) + `startNodeHeartbeat(nodeId, collectResources, {agentUrl})` (node pulse, resources every 5s, advertises the agent URL for #171); both take an injectable publisher |
| `shared/src/edition.ts` | Open-core edition flag: `Edition` type + `resolveEdition`/`getEdition`/`isHosted` (reads `NEXUS_EDITION`, defaults `community`) |
| `shared/src/edition.ts` | The open-core flag. **The image decides**: `getBuildEdition()` reads a stamp baked into the image, which outranks `NEXUS_EDITION`; `assertEditionIsRunnable()` exits on a mismatch. No stamp (running from source) → the env decides (#189) |
| `shared/src/database.ts` | `isPostgresUrl`/`databaseProvider` — which database `DATABASE_URL` names; the one rule both services use to pick a Prisma client (#241) |
| `shared/src/copyDatabase.ts` | Moving an installation between databases (#241): `modelsFromDmmf`, `copyOrder` (topological, refuses a cycle), `copyDatabase` (paged by primary key, refuses a non-empty target, checks counts). Pure; `scripts/sqlite-to-postgres.mjs` wires it to the clients |
| `shared/src/version.ts` | Build identity: `getVersion()` (reads `APP_VERSION`, baked by the release build) + `buildInfo()` → `{ version, edition }`, spread into every service's `/health` (#173) |
| `shared/src/outbox.ts` | `PublishOutbox` + `startOutboxFlusher` — holds a failed publish and replays it **in order** when the broker returns; bounded (drop-oldest + `droppedCount`). Wrap publishers whose events carry state (#167) |
| `shared/src/metrics.ts` | Prometheus metrics for every service (#246): dependency-free `MetricsRegistry` (counters, histograms, scrape-time gauges that fail soft), `httpMetrics` (labels by **route pattern**, never the raw path), `metricsHandler` (`METRICS_TOKEN`), `registerBuildInfo` |
| `shared/src/internalToken.ts` | Service-to-service shared secret: `INTERNAL_TOKEN_HEADER`, `getInternalToken`, `tokensMatch` (constant-time). Guards the Node Agent's internal API (#169) |
| `shared/src/events.test.ts` | Wire-compatibility guard tests (encryption round-trip, ciphertext layout, envelope shape) |

### services/control-room (heartbeat monitoring)
| Path | Contents |
|---|---|
| `src/monitor.ts` | Pure monitor core: `statusFor`, `healthyOverlapMs` (exact threshold splitting) + `Monitor` — per-source liveness, status transitions (capped ring buffer) and uptime % ; every method takes an explicit `now` |
| `src/dlq.ts` | Dead-letter watch (#243): pure `readDlq`/`describeDlq` over an injected queue probe. Reports `unknown` rather than `0` when the broker cannot be asked — not knowing is not the same as knowing nothing failed |
| `src/index.ts` | Wiring: HTTP `/health` · `/status` (+ `uptimePercent`) · `/uptime` (transitions + cumulative), consumes `monitoring.heartbeat.#`, healthy→degraded(3s)→offline(10s) |
| `Dockerfile` | Multi-stage workspace build (pattern shared by all services) |

### services/node-agent (Docker host agent)
| Path | Contents |
|---|---|
| `src/runtime.ts` | `ContainerRuntime` interface + `DockerodeRuntime` (real Docker via dockerode) + host resource collection + per-container log/stats streams |
| `src/stats.ts` | `parseDockerStats` — pure derivation of `ContainerStats` (CPU%, mem, network) from a Docker stats sample |
| `src/ports.ts` | Pure `publishPorts`/`parseContainerPort` (#313) — the container side of a mapping may name its protocol in Docker's notation (`2456/udp`, `27015/tcp+udp`); no suffix means TCP, as before. The protocol used to be hardcoded, and Docker *defaults* to TCP, so a UDP game published nothing at all: three of the four eggs are UDP games and Valheim and Rust need no TCP for play. The container ran, the panel showed it green, and nobody could join |
| `src/limits.ts` | `resourceLimitsToHostConfig` — pure translation of a server's `ResourceLimits` (%) into Docker HostConfig caps (Memory, NanoCpus, RestartPolicy, …) enforced at start |
| `src/cgroupSupport.ts` | What this host's cgroups actually accept (#288): pure `withCgroupSupport` drops HostConfig fields the kernel would reject, `detectCgroupSupport` probes for them. Setting `BlkioWeight` on a host with no `io.weight` fails **container init**, and the form defaults `ioPriority: normal` — so every server on Docker Desktop refused to start. `io` in `cgroup.controllers` is not the signal; the file's existence is |
| `src/files.ts` | Pure file helpers: `normalizeContainerPath` (traversal guard), `parseLsOutput`, `buildTarball`, `extractSingleFile` (the one file in a `getArchive` tar; skips PAX headers, refuses a directory or link) |
| `src/fileRoutes.ts` | `createFileRouter` — internal container-file CRUD HTTP (list/read/write/mkdir/rename/delete) over the runtime, plus a raw-bytes read (`GET /files/:id/binary`, capped by `MAX_DOWNLOAD_BYTES`) for SFTP (#235) |
| `src/databases.ts` | `buildDatabaseSpec` (engine→image/env/port) + `pickDatabasePort` — pure, for provisioning a managed DB container |
| `src/dbRoutes.ts` | `createDatabaseRouter` — internal DB provision/deprovision HTTP (starts/stops an engine container) |
| `src/backups.ts` | Pure backup helpers: `backupRef`, `isSafeRef`, `backupFilePath` (traversal-safe tar paths) |
| `src/bkRoutes.ts` | `createBackupRouter` — internal backup HTTP: tar snapshot/restore/delete/**download** of a container path (stored on the node, and off-site when configured — restore/download fall back to it, #232) |
| `src/s3.ts` | Off-site backups (#232): `signV4` (hand-rolled SigV4, pinned to AWS's published example; matches botocore byte-for-byte), `S3Target` put/get/delete, `offsiteFromEnv` (`BACKUP_S3_*`, off unless bucket + keys are set) |
| `src/disk.ts` | Pure disk reporting (#276): `diskUsageFrom` (statfs blocks → GB, counting the root reserve as used) + `collectDisk`, which reports **nothing** when it cannot measure. The agent used to return `0`, which the panel rendered as an empty disk beside real meters |
| `src/imports.ts` | Directory imports (#268): pure `isContained`/`resolveImportPath` (symlink-resolved containment against `IMPORT_ROOT`) + the internal validate router. **A bind mount is a host-escape primitive** — admin-only, off unless `IMPORT_ROOT` is set, and re-checked by the agent at start |
| `src/volumes.ts` | Server data (#324): pure `volumeNameFor` (deterministic per deployment + path), `pathsToPersist` (requested ∪ image `VOLUME`s, minus an imported bind) and `createDataRouter` — internal `DELETE /deployments/:id/data`, which removes only what carries the `nexusinfra.deployment` label. **Stop removes the container, so anything not in one of these volumes is gone on the next start** |
| `src/images.ts` | Image updates (#239): pure `imageUpdateStatus` (registry vs node vs container → `current`/`update-available`/`pulled-not-applied`/`unknown` — never "current" when the registry could not be asked) + internal `GET /images/status`. The `server.update` command pulls **before** it recreates, so a failed pull never takes a server down |
| `src/migrateRoutes.ts` | Moving a server (#234), node side: list/export/import/remove a server's volumes (tar streams through a created-never-started carrier container) + receive a backup tar. **Both imports refuse to overwrite** — two agents on one daemon share volumes, and an import "into" the source followed by the source clean-up would delete the only copy |
| `src/diskUsage.ts` | Per-server disk use (#347): pure `diskByDeployment` over Docker's `system df` (volumes by deployment label + the writable layer), a one-minute cache that shares an in-flight walk, and the internal `GET /disk` · `/deployments/:id/disk`. Docker's `-1` stays **unknown**, never `0`. Measured, not enforced — `StorageOpt` would cap only the writable layer, and the data is in volumes (#278) |
| `src/execRoutes.ts` | `createExecRouter` — internal console HTTP: one-shot `sh -c` command exec in a container (#68) |
| `src/terminal.ts` | `attachTerminal` — pure bridge wiring a WebSocket to an interactive TTY session (`runtime.execInteractive`); JSON `input`/`resize` frames in, raw output out (#71) |
| `src/internalAuth.ts` | `requireInternalToken` (Express) + `upgradeAuthorized` (WS handshake) — every internal route/upgrade needs the shared token; `/health` stays open (#169) |
| `src/agent.ts` | Command handling: consumes server.start/stop/restart/update for this node, publishes server.started/stopped/crashed; dependency-injected for testing (index.ts injects the outbox-backed publisher). `handleContainerEvent` (#332) reports containers that die or come back **without being asked** — fed by `runtime.watchContainers` (Docker events); a container the agent removed is gone when it looks, and its own restarts are marked only while they run |
| `src/agent.test.ts` | Unit tests with a fake runtime + captured publisher (no Docker/broker needed) |
| `src/index.ts` | Entry: DockerodeRuntime + agent, binds `nexusinfra.node-agent.{nodeId}`, HTTP `/health` + internal SSE `/logs/:containerId` · `/stats/:containerId` + file CRUD + internal WS `/terminal/:containerId` (PTY shell, #71) |

### services/orchestrator (deployment control plane)
| Path | Contents |
|---|---|
| `prisma/postgres/` | The PostgreSQL schema (**generated** from `../schema.prisma` by `scripts/postgres-schema.mjs`) and its own migrations (#241) |
| `prisma/schema.prisma` | Prisma + SQLite schema: `Node`, `ServerConfig`, `Deployment`, `DeploymentEvent`, `ServerDatabase`, `ServerBackup`, `ServerSchedule`, `ServerSubuser`, `PortAllocation` (#233). `prisma/migrations` is the schema source of truth |
| `src/types.ts` | Domain records + the `Repository` interface (decouples logic from the DB) |
| `src/repository.ts` | `InMemoryRepository` — backs unit tests and a DB-less local mode |
| `src/db.ts` | `getPrisma()` + `PrismaRepository` (SQLite-backed `Repository`) |
| `src/nodeRegistry.ts` | Consumes `monitoring.heartbeat.node.#`, upserts nodes (liveness/resources only — never clobbers a registered name/location), derives health (3s/10s) |
| `src/nodeSelection.ts` | Pure least-loaded `selectNode` (healthy nodes, ranked by CPU+RAM load) |
| `src/agentUrl.ts` | Pure `resolveAgentUrl`/`normalizeAgentUrl` — which node's agent to call, falling back to `NODE_AGENT_URL` for single-node (#171) |
| `src/dbProvision.ts` | Pure managed-DB helpers: `isDatabaseEngine` guard + `generateDatabaseCredentials` (safe name/user/password) |
| `src/minecraftVersions.ts` | Which Minecraft versions the panel offers (#311). Asks Mojang's manifest, caches 6h, **falls back to a baked list offline** — a community install is somebody's own machine and may have no route out. Releases only (the manifest is mostly snapshots) and in Mojang's order, since `1.9`/`1.10` do not sort as text. The list is a **suggestion, never a gate**: `eggs.ts` validates a version by shape, so a cold cache cannot refuse a version the image would install |
| `src/eggs.ts` | Egg catalogue (#231) — the recipes a server is created from (image, ports, dataPath, typed variables with defaults/validation) + `buildEggDeployment`. **Pure.** A variable may declare `showWhen` (#311) so it is neither asked for nor sent when it does not apply — `NEOFORGE_VERSION` means nothing to a Paper server, and it is one character from `FORGE_VERSION`, which installs the wrong loader. Lives here, not in the browser: the recipe validates server-side, so a caller that skips the form cannot skip `EULA=TRUE` or inject arbitrary container env. Replaced `dashboard/src/gameSpec.ts`. Six eggs: Minecraft Java + Bedrock, Palworld, Valheim, Rust, CS2 (#315) — Bedrock keeps its **own** version list, since Java's numbering would be a plausible wrong answer |
| `src/errorBoundary.ts` | The crash guard (#294): `catchAsync` (routes a rejected async handler into Express's error pipeline — Express 4 does not await handlers), `errorHandler` (500, logs the cause, never returns it) and `installProcessGuards`. One failing `DELETE` used to end the **process**, taking every server's control plane with it. Wrapping is applied per router in `index.ts`, not per route — a rule 60 handlers must remember is a rule that gets forgotten once, in the route that matters |
| `src/containerName.ts` | Pure `containerNameFor` (#286) — display name + deployment id → a Docker-valid container name. The display name used to be passed through verbatim, so a space meant Docker refused the create and the panel showed a crash with no container. Deterministic (a restart reuses the name) **and** id-suffixed, because `start` force-removes whatever holds the name — two servers called the same thing used to delete each other |
| `src/capacity.ts` | Pure node capacity (#275): total vs **committed** vs used, and what is left to hand out. Committed is the sum of the caps already given to servers there — the form used to answer "how much can I give away" with live usage, which is wrong twice (idle servers still hold their cap; page cache makes an empty node look full) |
| `src/memory.ts` | Pure memory budgeting (#271, #308): `parseMemoryMb`, `containerMemoryMb`, `jvmOverheadMb`, `heapBudgetProblem`, `largestHeapForCap`, **`derivedHeapMb`**. The container cap and the JVM heap were two settings for the same RAM — the kernel enforces the cap and the JVM *commits* the heap, so a heap that does not fit is a container killed mid-save. Since #308 the heap is **derived** from the cap on every write unless the request names one, so there is one number to set; the collision was in the defaults too (50% of 4 GB vs a fixed `2G`). Mirrored by `dashboard/src/memory.ts` |
| `src/startCommand.ts` | The one builder for `server.start` (#324): `startCommandFor` (+ `dataMountFor`, `persistPathsFor`, `parsePersistPaths`). Creation, start and reconciliation all use it — reconciliation's hand-written copy had dropped an imported server's mount. **Never build a start payload by hand** |
| `src/imageUpdate.ts` | `requestImageUpdate` (#239) — the one path for the update button and the `update` schedule action: emits `server.update` (recreate only when running) on the node the server is on |
| `src/retention.ts` | Pure backup retention (#232): `expiredBackups` (keepLast / keepDays are both limits; the newest backup is never expired) + `parseRetention` + `withPlanCeiling` (a plan's backups-per-server ceiling tightens `keepLast`, never loosens it, #297) |
| `src/backups.ts` | `takeBackup` / `enforceRetention` / `sweepRetention` (#232) — the one path for the Backups tab, the `backup` schedule action and the hourly sweep. Defaults the snapshot to the server's own data directory, not `/data` |
| `src/migrate.ts` | `planMigration` (#234): validates synchronously, returns the work to run in the background; copy volumes → copy backups → switch node → clean source. A failure before the switch removes only what it created. `isMigrating` is the lock start/update/delete check |
| `src/portPool.ts` | Pure host-port planning (#233): `planPorts` (`auto` from the node's range, explicit ports held to it, conflicts named, 400 vs 409) + `parsePortRange`, `rangeOf`, `PortConflictError` |
| `src/portAllocation.ts` | The repository side of host ports: `takenPorts`, `checkPorts`, `allocatePorts` (plan + write; the unique (node, port) index is the real guard), `backfillPortAllocations` (servers from before #233, once at start) |
| `src/notify.ts` | Notifications, pure (#236): events, `webhookBody` (json/discord/slack), `signBody` (HMAC), `nextAttemptDelayMs`, `isPrivateAddress`, `parseChannelInput` (email only to your own address; node events admin-only), `nodeTransitions` |
| `src/notifier.ts` | `createNotifier` — recipients (owner, shares, team; admins for node events), durable delivery rows, atomic claim, retry/give-up; `defaultTransports` (node http with `guardedLookup`, which refuses private addresses **at connect time**, and nodemailer) |
| `src/notificationRoutes.ts` | `/me/notifications` CRUD + test + deliveries. A webhook secret is returned once |
| `src/cron.ts` | Pure 5-field cron matcher (`cronMatches`, `isValidCron`) for the schedule runner |
| `src/scheduler.ts` | Schedule runner: pure `selectDue`/`tickSchedules` + `startScheduler` (1-min poll); actions injected |
| `src/users.ts` | Account domain: bcrypt hashing, email normalisation, password rules, edition-derived signup policy, and `createUserService` (register / authenticate / change password / first-run bootstrap) (#174) |
| `src/auth.ts` | `AuthProvider` seam (`createLocalAuthProvider`; FinVault JWT swaps in at #17) + `signToken`/`verifyToken` → `Principal`, `requireAuth`, `principalOf`, `requirePlatformAdmin`, and the auth/account/admin routers. **No anonymous fallback** — no token means 401. `createRequireAuth(repo)` additionally checks the session the token names still exists (#227), which is what makes signing out actually sign you out, and accepts an `nxi_` API token as the same account (#228) — `requireTokenScope` (mounted once in index.ts) then holds it to its scopes. A token cannot mint tokens |
| `src/passwordReset.ts` | Self-service reset by email (#344): mint/hash (the secret is only stored as a digest), `parsePanelUrl`, and the public `POST /auth/password-reset` (+ `/confirm`) router. On only with `SMTP_URL` **and** `PANEL_URL` — the link is never built from the Host header. Same `202` for every address, mail sent after the response; the password is checked *before* the link is spent |
| `src/totp.ts` | Pure TOTP + recovery codes (#229): RFC 6238 in ~40 lines over Node's HMAC, checked against the RFC's own vectors — a dependency for that much code is a dependency to keep current in an auth path. `REQUIRE_TOTP=true` makes it mandatory, but never by refusing a login: an un-enrolled account signs in and finds only enrolment open, because refusing would lock out the one administrator the moment the flag flips |
| `src/apiTokens.ts` | Pure API-token core (#228): mint/hash (`nxi_` prefix, SHA-256 — the secret is 256 random bits, so bcrypt would only rate-limit us) + scopes. **Scope is by HTTP method, not a path table** — a path table falls behind and silently unscopes the next new route, for token callers only. `admin` is separate from the account's platform role |
| `src/loginLimiter.ts` | Pure per-IP **and** per-account login throttle (#225). The gateway's limiter is bypassed by the dashboard's nginx, so credential checks were unlimited. A lockout answers the same 401 as a wrong password — anything else confirms the account exists |
| `src/access.ts` | **Pure** authorization core: `Role`/`Permission`, `ROLE_PERMISSIONS`, `can`, `resolveRole`, `strongestRole` — plus the team half (#224): `TeamRelation`/`TeamPermission`, `canOnTeam`, `resolveTeamRelation`. A team has no role ladder; the role on a membership is a *server* role. No Express, no DB — the whole matrix is unit-tested (#175) |
| `src/accessGuard.ts` | `accessGuard(repo)` (mounted once on `/deployments/:id`; **404 for no access**, never 403) + `requirePermission(p)` per route + `accessOf(req)` + `resolveAccess(repo, principal, id)` — the guard's own resolver, for routes that address several servers (#238); and the same shape for teams (#224): `teamGuard(repo)` on `/teams/:id`, `requireTeamPermission(p)`, `requireTeamPermissionOrSelf(p, subject)` (leaving is not managing), `teamAccessOf(req)`, `teamAccessFor(repo, id, userId)` for when a team is named in a body |
| `src/teams.ts` | Teams (#177): `createTeamRouter` (`/teams`, membership) + `createServerTeamRouter` (`PATCH /deployments/:id/team`). Deleting a team **detaches** its servers, never deletes them. Routes declare a team permission and sit behind `teamGuard` — no handler resolves membership by hand (#224) |
| `src/deploymentQuery.ts` | Pure search/filter/paging for the server list (#237): `parseFilter`, `parsePage` (limit always applied, capped at 200), `pageOf` (total order on createdAt **then id**, or paging shows one row twice and hides another). `GET /deployments` answers `{ items, total, limit, offset }` — a page with no count cannot say there is more, and silent truncation is worse than the unbounded list it replaced |
| `src/entitlements.ts` | Hosted plan entitlements (#297): pure `usageFor` (memory in MB on each server's own node), `ramProblem`/`ramChangeProblem` + `fetchEntitlements` (fail-open, logged). Measured against the **owner's** plan, whoever edits; the platform role buys no exemption. Under a memory ceiling an uncapped server is refused — it could take the whole node. Lowering is always allowed, so an account over its plan has a way back |
| `src/transfer.ts` | Pure `planTransfer` (#230) — who owns the server next, what the outgoing owner keeps, and the audit line. Ownership was fixed at creation, so an owner who left orphaned their servers: only `owner` may delete one or manage its access. Owner-level permission, because an admin who could transfer could hand the server to themselves; the repository applies the plan in **one transaction**, since an owner who moved without the retained share landing is access silently lost |
| `src/config.ts` | `createConfigRouter` — public `GET /config` → `{ edition, passwordResetByEmail, sftpPort }` (mounted before auth) |
| `src/sftp.ts` | SFTP, the protocol half (#235): `createSftpServer` over an injected `SftpFiles`, plus pure `parseSftpUsername` (`<email>.<server>`, split on the **last** dot), `resolveSftpPath`, `openIntent`, `WriteBuffer`. Password auth only; no shell/exec. A write that fails part way poisons its handle, so the close does **not** upload the fragment over the old file. ssh2 is CommonJS — import it whole, named imports fail under Node's ESM loader (tests do not catch that) |
| `src/sftpBackend.ts` | SFTP, the account/agent half: `createSftpAuthenticator` (password or `nxi_` token; a 2FA account must use a token; `file.read` to log in; shares the panel's login limiter) and `createAgentSftpFiles` — access, role and container **re-resolved on every operation**, so a revoked share ends an open session. `loadOrCreateHostKey` (ed25519, `0600`, on the data volume) |
| `src/api.ts` | Express deployment API: create/list/get deployments, stop/start/restart/**delete**, node health; enforces plan quotas via the Billing Bridge (hosted). Control actions live in one `controls` table shared by the single routes and `POST /deployments/bulk` (#238), which is mounted **before** the per-server guard — anything under `/deployments/<word>` that is not an id must be, or the guard claims it as a server id and answers 404 |
| `src/reconcile.ts` | Pure `reconcileNode` (records vs what a node actually runs) + the `infra.node.inventory` handler (#244). The outbox (#167) protects reports from a *broker* outage; nothing protected them from the agent process dying, after which a stopped server kept showing green — and nobody investigates a green light |
| `src/lifecycle.ts` | Consumes `infra.server.started/stopped/crashed`, updates deployment status + audit |
| `src/suspend.ts` | `createSuspendHandler` — consumes `billing.server.suspend` (hosted), stops each named running deployment + audits it |
| `src/billingProxy.ts` | `createBillingProxyRouter` — authenticated `/billing/*` proxy → Billing Bridge, injecting the JWT user id (dashboard never sends a user id) |
| `src/monitoring.ts` | `createMonitoringRouter` — `GET /monitoring` proxies the Control Room's `/status` to the dashboard (`reachable:false` if it's down) |
| `src/wsProxy.ts` | Pure `pipeSockets` + `toWsUrl` — the terminal WS proxy plumbing; `index.ts` authenticates the JWT, resolves the container, and pipes the client WS ↔ the Node Agent's `/terminal` WS (#71) |
| `src/index.ts` | Entry: PrismaRepository + consumers on `nexusinfra.orchestrator`, mounts API, starts the schedule runner (restart/backup actions), HTTP `/health` (`:9200`) |
| `src/*.test.ts` | Unit tests with the in-memory repo + captured publisher (no Docker/broker/DB needed) |
| `Dockerfile` | Multi-stage build; runtime applies `prisma migrate deploy` then starts |

### services/billing-bridge (usage billing — hosted edition only)
| Path | Contents |
|---|---|
| `src/pricing.ts` | Pure pricing: `BillingPlan` (incl. the #297 entitlements `maxRamMb`/`maxBackupsPerServer`, null = no ceiling) + `resourceFactor` (CPU/RAM → multiplier) + `billableHours`/`computeCharge` + `roundCurrency` + `chargingModel` (the model as data, so the panel states what the charge does) |
| `src/quotas.ts` | Pure plan quota checks (`quotaLimit`, `withinQuota`) for servers/databases |
| `src/tracking.ts` | Pure runtime math: `hoursBetween` + `accruedHours` (open interval counts up to now) |
| `src/wallet.ts` | Pure credit-wallet math: `applyTopUp`/`applyCharge`/`canCover` |
| `src/types.ts` | Domain records + the `Repository` interface (plans, intervals, wallet, ledger, cycles) |
| `src/repository.ts` | `InMemoryRepository` — backs unit tests and a DB-less mode |
| `src/db.ts` | `getPrisma()` + `PrismaRepository` (SQLite) + `ensureDefaultPlan` seed |
| `src/service.ts` | `createBillingService` — events→intervals, wallet, and the FinVault top-up flow (`payment.request`/confirmed/failed); dependency-injected. A confirmation credits once (conditional transition) and only for the requested amount; `expireStaleTopUps` turns an unanswered top-up *Not confirmed* after `TOPUP_TIMEOUT_MS` — not final, a late confirmation still credits (#298) |
| `src/prisma.integration.test.ts` | The billing repository on real SQLite and PostgreSQL: concurrent confirmations credit once (#298) |
| `src/cycle.ts` | Monthly cycle runner: pure `computeCycleCost`/period helpers + `runBillingCycle` (charge credit → `billing.server.suspend` on short balance → `invoice.generate`) + `startCycleRunner` (hourly poll, idempotent) |
| `src/api.ts` | `createBillingRouter` — HTTP: wallet/usage/ledger/plan/quota + `POST /topup` |
| `src/index.ts` | Entry: PrismaRepository + service; consumes deployment/runtime + `bank.payment.*`; HTTP `/health` (+ billing routes when hosted) on `:9300`; inert in community |
| `prisma/schema.prisma` | Prisma + SQLite: `BillingPlan`, `UserPlan`, `ServerBilling`, `CreditWallet`, `CreditLedger`, `BillingCycle`. `prisma/migrations` is the source of truth |
| `Dockerfile` | Multi-stage build; runtime applies `prisma migrate deploy` then starts |

### services/gateway (API gateway — single entry point, #20)
| Path | Contents |
|---|---|
| `src/routes.ts` | Pure routing table + `matchRoute` (longest-prefix, public/protected) |
| `src/auth.ts` | `verifyToken`/`bearerToken` — validates the same JWTs the orchestrator issues (FinVault JWT later, #17) |
| `src/rateLimit.ts` | Pure token-bucket `RateLimiter` (per-IP/user, injected clock) |
| `src/gateway.ts` | `createGateway` → `{ app, upgrade }` (and `createGatewayApp` for just the app) — CORS → rate limit → token (protected routes) → **streaming** reverse proxy to the matched backend. One `gate` decides for HTTP and WebSocket upgrades alike, so a socket is no way around the limiter. A JWT is verified; an `nxi_` API token is opaque here and passed through for the orchestrator to judge. A client disconnect aborts the backend request — a log tail never ends on its own |
| `src/upgrade.ts` | `proxyUpgrade`/`refuseUpgrade` — the WebSocket proxy (#69), at the byte level: the handshake is replayed, the 101 relayed, the sockets piped. No frame parsing, so no WS library at runtime |
| `src/live.test.ts` | Real sockets on both sides: SSE arrives before the stream ends, disconnects propagate, terminal frames round-trip, refusals answer before dialing |
| `src/index.ts` | Entry: builds the gateway for `ORCHESTRATOR_URL`, wires `upgrade` on the HTTP server, heartbeat, listens `:9400` |
| `Dockerfile` | Multi-stage build |

### dashboard (React web panel)
| Path | Contents |
|---|---|
| `src/api.ts` | Typed Orchestrator client (login, nodes, deployments, create, stop); attaches the JWT; `ApiError` on non-2xx |
| `src/session.ts` | Token get/set/clear + `isAuthenticated` (single place that touches the token in localStorage) |
| `src/edition.tsx` | `EditionProvider` + `useEdition()` — reads `GET /config`, exposes `edition`/`isHosted` so billing UI renders only in hosted |
| `src/buildEdition.ts` | `BILLING_INCLUDED` — a **compile-time** constant (`__BUILD_EDITION__`, set in vite.config.ts). Distinct from `useEdition()`: this answers "is the code in the bundle?", that answers "is the server hosted?" (#190) |
| `scripts/verify-edition.mjs` | Greps the **built** bundle to prove a community build contains no billing code; run by the image build, so tree-shaking regressions fail the build (#190) |
| `src/permissions.ts` | The panel's copy of the server permission matrix (#178) — `can`/`permissionsFor`/`ROLE_LABELS`. **Mirrors `orchestrator/src/access.ts`; change both together.** An absent role means full access, so an owner is never locked out of their own server |
| `src/prefs.ts` | Persisted client preferences (localStorage): first-run intro flag + customisable New Deployment defaults (`getDeploymentDefaults`) |
| `src/pages/Preferences.tsx` | Preferences page — edit/save/reset the New Deployment defaults |
| `src/pages/ResetPassword.tsx` | Where the mailed reset link lands (#344) — public, checks length and the repeat before spending the link |
| `src/pages/Account.tsx` | Account page (#221) — who you are signed in as + change your own password. Platform role is read-only: your own standing is not yours to raise |
| `src/pages/Users.tsx` | Accounts page (#222) — platform admins list and create accounts. The only way in for the community edition, where nobody self-registers. Nav link hidden for non-admins; `/users` answers 403 regardless |
| `src/pages/NodeDetail.tsx` | Per-node view (`/nodes/:id`): live CPU/RAM meters + session sparkline, hosted deployments, deregister |
| `src/routes.tsx` · `src/App.tsx` | Route table (public `/login`; the rest behind `RequireAuth` + `Layout`) wrapped in the router |
| `src/components/{Layout,RequireAuth}.tsx` | Nav shell + auth-guard route wrapper. When the bar does not fit, the nav and its actions fold behind a Menu button (`aria-expanded`, closes on Escape and on navigation); on a wide screen the wrapper is `display: contents`, so nothing moves (#247). **Fit is measured, not a breakpoint** (#352, `src/navFit.ts`): the link count depends on edition and role, and a fixed 900px let a hosted admin's bar overflow up to ~1300px. Labels never wrap and controls never shrink, so not fitting shows up as overflow |
| `src/components/Dialog.tsx` | `DialogProvider` + `useDialog()` → promise-shaped `confirm`/`prompt` (#299), replacing 16 `window.confirm`/`prompt` calls. Native dialogs announce the origin, give a deletion the same weight as a rename, and **freeze the page thread**, so no automated run ever reached the other side of one. Destructive confirmations look destructive and focus **Cancel**, so a reflexive Enter does not delete; prompts validate as you type. Without a provider every dialog resolves *no* — these guard deletions |
| `src/focusTrap.ts` | `useFocusTrap` + pure `nextFocus` (#247): Tab stays inside a modal and focus returns to what opened it. Used by `Dialog`, `DeploymentDrawer` and `IntroTour`. Remembers the last focus *outside* any modal, because an `autoFocus` inside one takes focus before an effect can read the opener |
| `src/components/SftpDetails.tsx` · `src/sftp.ts` | The Files tab's "Connect with SFTP" (#235): host, port (from `/config`), the `<email>.<id8>` user name and an `sftp://` link; tells a 2FA account to use a token. Renders nothing when SFTP is off |
| `src/components/InfoHint.tsx` | Accessible "?" tooltip for contextual option help (hover/focus); used across the option forms |
| `src/components/Terminal.tsx` | xterm.js interactive terminal (#71) — dynamically imports xterm, connects the exec WebSocket (`terminalWsUrl`); mounted by the server-detail Terminal tab |
| `src/components/IntroTour.tsx` | First-run intro walkthrough (skippable, re-openable from the nav Help button) |
| `src/pages/{Login,Overview,NewDeployment,Servers}.tsx` | Login, node health/overview (+ Platform-services strip from Control Room monitoring, #157), deployment form, live server list + stop |
| `src/components/PlanPanel.tsx` · `src/plan.ts` | The plan beside the size being chosen in New Deployment (#297): ceilings, what is spent, whether this server fits (with a one-click "use what is left"), and the charging model in words. **Hosted-only** — aliased to `PlanPanel.stub.tsx` in a community build and marked in `verify-edition.mjs` |
| `src/pages/Billing.tsx` | Billing page (hosted only): credit balance, top-up via FinVault, cycle usage/cost, payment history — route + nav link gated on `useEdition().isHosted` |
| `src/health.ts` | Status → colour helpers shared across pages |
| `src/test/setup.ts` · `vitest.config.ts` | jsdom + Testing Library setup; in-memory localStorage |
| `Dockerfile` · `nginx.conf` | Static build served by nginx, which proxies `/api` to the orchestrator |

### cli (`nexusctl`, #240)
| Path | Contents |
|---|---|
| `cli/src/commands.ts` | Every command, dependency-injected (`run(argv, deps)` → exit code) so the CLI is tested with a fake fetch. Servers are resolved by id or **exact** name — an ambiguous name is refused with the ids. Start/stop/restart/kill go through `POST /deployments/bulk` |
| `cli/src/client.ts` | `Client` — JSON requests, binary download, SSE stream; bearer API token |
| `cli/src/config.ts` | `~/.config/nexusctl/config.json` (mode 600), `NEXUSCTL_URL`/`NEXUSCTL_TOKEN` win |
| `cli/src/index.ts` | The `nexusctl` bin |

### Infrastructure
| Path | Contents |
|---|---|
| `docker-compose.yml` | RabbitMQ + control-room + node-agent + orchestrator + dashboard stack |
| `vitest.workspace.ts` | Splits tests into `backend` (node) and `dashboard` (jsdom) projects |
| `.env.example` | Env contract — documents the FinVault-shared vars (`RABBITMQ_URL`, `FINVAULT_MESSAGE_KEY`) |
| `allinone/` | All-in-one image (#203): one container with every service under s6, its own broker, and first-start secret generation. Published as `nexusinfra-community` / `nexusinfra-hosted`. **Single machine** — a second host runs the standalone agent |
| `scripts/` | Repo-root scripts the images also carry (#241): `postgres-schema.mjs` (derive/check a PostgreSQL schema), `db-deploy.mjs` (`npm run db:deploy` — the migrations for whichever database `DATABASE_URL` names), `sqlite-to-postgres.mjs` (move an installation's data) |
| `deploy/install.sh` · `deploy/install.ps1` | Release installer: picks an edition, generates `JWT_SECRET`/`INTERNAL_API_TOKEN`/admin password, writes `.env`, starts the stack. Never overwrites an existing `.env` unasked (#191) |
| `deploy/community/` · `deploy/hosted/` | Self-contained release bundles: compose pinned to published images + `.env.example` + README. Neither needs a checkout of this repo; both are attached to each GitHub release (#179) |
| `.github/workflows/release.yml` | On a `v*` tag: re-run CI in both editions, then publish `nexusinfra/<service>:X.Y.Z-{community,hosted}` to GHCR (nested so the six read as one family, #200). `billing-bridge` builds hosted only (#179) |
| `.github/workflows/ci.yml` | CI: npm ci → build → lint (if present) → test, on PRs and pushes to dev/staging/main |
| `eslint.config.js` | Flat ESLint config (typescript-eslint recommended) covering all workspaces |

### docs/
| Path | Contents |
|---|---|
| `docs/architecture.md` | Services as built, event bus topology, routing keys in use, status model |
| `docs/security.md` | Payload encryption, secrets handling, auth plan, known gaps |
| `docs/installer.md` | What the release installer does step by step, and what it deliberately does not do |
| `docs/images.md` | Per-image reference (ports, env, volumes, what runs once vs per host) for assembling a stack by hand (#201) |
| `docs/deployment.md` | Local dev, Docker image pattern, combined-with-FinVault deployment, CI |
| `docs/api.md` | HTTP endpoints + event contract summary |

## 8. Conventions & gotchas

- Monorepo: npm workspaces (`services/*`, `shared`), TypeScript ESM (`"type": "module"`, NodeNext),
  imports use `.js` extensions. Mirrors FinVault's layout deliberately.
- **`shared` must build before services** — the root `build` script sequences this; don't bypass it.
- Services depend on shared via `"shared": "file:../../shared"` and import from the compiled `dist/`.
- **Never rename the `finvault.events` exchange or change the encryption constants** (`KDF_SALT`,
  algorithm, ciphertext layout) — that is the FinVault integration contract.
- `FINVAULT_MESSAGE_KEY` and `RABBITMQ_URL` must match FinVault's values for cross-platform events;
  empty key = plaintext payloads (local dev only).
- Event payloads may arrive encrypted — always read them via `readPayload()`, never `event.payload` directly.
- **FinVault's gateway publishes every event as `events.<type>`** (e.g. `events.payment.confirmed`), not on
  the `bank.payment.*` keys NexusInfra named. Bind both when consuming anything FinVault sends (#298), and
  match on a reference *you* issued — FinVault's own payments share the key.
- **A ledger status changes through `transitionLedgerStatus`, never read-then-write.** The broker delivers
  at least once; two deliveries of one confirmation used to both see "pending" and both credit (#298).
- Consumers `nack` without requeue on error → message dead-letters to `finvault.events.dlq` (3-retry
  semantics live at the broker level, not in code).
- **`publishRabbitEvent` returns `false` and drops the event when the broker is unreachable.** For any
  event that carries state, wrap the publisher in a `PublishOutbox` (#167) so it's replayed in order
  instead of lost — durable queues don't help a publish that never landed. Don't buffer heartbeats.
- **Agent calls must target the *owning* node** — resolve it with `agentUrlFor(deployment.nodeId)`,
  never the bare `NODE_AGENT_URL` constant (that is only the single-node fallback). Getting this wrong
  operates on the wrong host and fails silently with 2+ nodes (#171).
- **Every Orchestrator → Node Agent call must go through `agentFetch`** (or carry
  `INTERNAL_TOKEN_HEADER` explicitly, as the terminal WS dial does). The agent rejects untokened
  requests with 401 (#169) — a bare `fetch` to `NODE_AGENT_URL` will silently start failing.
- **A valid token says who you are, never what you may do.** `requireAuth` only authenticates;
  authorization is per-server and resolved separately (#175). Never infer permission from the fact
  that a request reached your handler.
- **Never read a user id from the request body or a query param** — take it from `principalOf(req)`.
  A caller-supplied id is a caller-chosen identity.
- **Never return a raw user record over HTTP** — go through `toPublicUser`, which drops the
  credential digest. The same applies to anything embedding a user.
- **An image's edition is fixed at build time and cannot be changed by `NEXUS_EDITION`** (#189). The
  variable still works when running from source. If a container exits complaining about the edition,
  the fix is to pull the other tag, not to set the variable harder.
- **Anything hosted-only added to the dashboard must be excluded from the community build** — alias
  it in `vite.config.ts` and add a marker to `verify-edition.mjs`, or the community bundle silently
  starts shipping code it cannot run.
- **Every schema change is made three times (#241).** Edit `prisma/schema.prisma` (SQLite, the
  source), run `npm run db:sync-postgres` to regenerate `prisma/postgres/schema.prisma`, and add a
  migration for **each** database. `schemas.test.ts` fails when the PostgreSQL schema is stale or the
  SQLite migrations fall behind; CI's integration job replays the PostgreSQL migrations against a real
  server. The client is picked by `DATABASE_URL` in `getPrisma()` — never `new PrismaClient()` elsewhere.
- **Two Prisma schemas in one workspace collide.** They both generate into the hoisted
  `node_modules/.prisma/client` and the last one wins — invisible while each service has its own
  image, fatal once two share one. `billing-bridge` generates into its own directory; anything new
  with a schema must do the same.
- **Anything that runs inside a container needs LF line endings** — see `.gitattributes`. CRLF makes
  the kernel read the carriage return as part of the interpreter path (`bad interpreter`), and it
  only shows up on a fresh clone on Windows.
- **Colour tokens are measured, not picked (#247).** Every text token clears WCAG AA on every surface
  it sits on, in both themes — checked with axe across the whole panel. `--color-primary` is for text,
  borders and marks; **`--color-primary-solid`** (and `--color-danger-solid`) is for a fill with white
  text on it. In the dark theme no single colour can do both. Hard-coded hex text colours and a
  `style={{ background: 'var(--color-danger)' }}` on a button are how contrast regresses — use the
  classes (`btn--primary`, `btn--danger-solid`).
- **The dashboard's `permissions.ts` is a mirror, not a second source of truth.** It exists so the
  panel doesn't offer buttons that would 403; change it in the same commit as `access.ts` or the two
  drift. Hiding a control is never a security measure — the API is.
- **A server's data lives in named volumes, not in its container (#324).** The agent removes a container
  on every stop and kill, so a new feature that recreates one (image update, migration) is safe only
  because of `volumes.ts`. Moving a server to another node means moving its volumes.
- Heartbeat cadence: 1s pulse; Control Room thresholds: degraded ≥3s, offline ≥10s.
- All timestamps are UTC ISO-8601 strings in event payloads.
- Dockerfiles build from the **repo root** context (they copy `shared/` + the service dir).
