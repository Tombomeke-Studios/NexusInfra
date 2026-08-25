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
- **Integration tests:** Docker Compose test target for RabbitMQ/database-dependent tests.
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
| API endpoints, request/response formats, routing keys | [docs/api.md](docs/api.md) |
| New/moved/renamed files, new commands, new gotchas | **This file** (map in section 7) |
| Setup / how-to-run instructions | README.md |
| Tasks, progress, follow-ups | [TODO.md](TODO.md) — and *only* there |
| Product concept / cross-project design decisions | `../CONCEPTS/` (separate repo — commit there separately) |

## 6. Commands

| What | Command (repo root) |
|---|---|
| Install workspace deps | `npm install` |
| Build everything (shared first) | `npm run build` |
| Run all tests | `npm test` |
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
| `shared/src/version.ts` | Build identity: `getVersion()` (reads `APP_VERSION`, baked by the release build) + `buildInfo()` → `{ version, edition }`, spread into every service's `/health` (#173) |
| `shared/src/outbox.ts` | `PublishOutbox` + `startOutboxFlusher` — holds a failed publish and replays it **in order** when the broker returns; bounded (drop-oldest + `droppedCount`). Wrap publishers whose events carry state (#167) |
| `shared/src/internalToken.ts` | Service-to-service shared secret: `INTERNAL_TOKEN_HEADER`, `getInternalToken`, `tokensMatch` (constant-time). Guards the Node Agent's internal API (#169) |
| `shared/src/events.test.ts` | Wire-compatibility guard tests (encryption round-trip, ciphertext layout, envelope shape) |

### services/control-room (heartbeat monitoring)
| Path | Contents |
|---|---|
| `src/monitor.ts` | Pure monitor core: `statusFor`, `healthyOverlapMs` (exact threshold splitting) + `Monitor` — per-source liveness, status transitions (capped ring buffer) and uptime % ; every method takes an explicit `now` |
| `src/index.ts` | Wiring: HTTP `/health` · `/status` (+ `uptimePercent`) · `/uptime` (transitions + cumulative), consumes `monitoring.heartbeat.#`, healthy→degraded(3s)→offline(10s) |
| `Dockerfile` | Multi-stage workspace build (pattern shared by all services) |

### services/node-agent (Docker host agent)
| Path | Contents |
|---|---|
| `src/runtime.ts` | `ContainerRuntime` interface + `DockerodeRuntime` (real Docker via dockerode) + host resource collection + per-container log/stats streams |
| `src/stats.ts` | `parseDockerStats` — pure derivation of `ContainerStats` (CPU%, mem, network) from a Docker stats sample |
| `src/limits.ts` | `resourceLimitsToHostConfig` — pure translation of a server's `ResourceLimits` (%) into Docker HostConfig caps (Memory, NanoCpus, RestartPolicy, …) enforced at start |
| `src/files.ts` | Pure file helpers: `normalizeContainerPath` (traversal guard), `parseLsOutput`, `buildTarball` |
| `src/fileRoutes.ts` | `createFileRouter` — internal container-file CRUD HTTP (list/read/write/mkdir/rename/delete) over the runtime |
| `src/databases.ts` | `buildDatabaseSpec` (engine→image/env/port) + `pickDatabasePort` — pure, for provisioning a managed DB container |
| `src/dbRoutes.ts` | `createDatabaseRouter` — internal DB provision/deprovision HTTP (starts/stops an engine container) |
| `src/backups.ts` | Pure backup helpers: `backupRef`, `isSafeRef`, `backupFilePath` (traversal-safe tar paths) |
| `src/bkRoutes.ts` | `createBackupRouter` — internal backup HTTP: tar snapshot/restore/delete of a container path (stored on the node) |
| `src/execRoutes.ts` | `createExecRouter` — internal console HTTP: one-shot `sh -c` command exec in a container (#68) |
| `src/terminal.ts` | `attachTerminal` — pure bridge wiring a WebSocket to an interactive TTY session (`runtime.execInteractive`); JSON `input`/`resize` frames in, raw output out (#71) |
| `src/internalAuth.ts` | `requireInternalToken` (Express) + `upgradeAuthorized` (WS handshake) — every internal route/upgrade needs the shared token; `/health` stays open (#169) |
| `src/agent.ts` | Command handling: consumes server.start/stop/restart for this node, publishes server.started/stopped/crashed; dependency-injected for testing (index.ts injects the outbox-backed publisher) |
| `src/agent.test.ts` | Unit tests with a fake runtime + captured publisher (no Docker/broker needed) |
| `src/index.ts` | Entry: DockerodeRuntime + agent, binds `nexusinfra.node-agent.{nodeId}`, HTTP `/health` + internal SSE `/logs/:containerId` · `/stats/:containerId` + file CRUD + internal WS `/terminal/:containerId` (PTY shell, #71) |

### services/orchestrator (deployment control plane)
| Path | Contents |
|---|---|
| `prisma/schema.prisma` | Prisma + SQLite schema: `Node`, `ServerConfig`, `Deployment`, `DeploymentEvent`, `ServerDatabase`, `ServerBackup`, `ServerSchedule`, `ServerSubuser`. `prisma/migrations` is the schema source of truth |
| `src/types.ts` | Domain records + the `Repository` interface (decouples logic from the DB) |
| `src/repository.ts` | `InMemoryRepository` — backs unit tests and a DB-less local mode |
| `src/db.ts` | `getPrisma()` + `PrismaRepository` (SQLite-backed `Repository`) |
| `src/nodeRegistry.ts` | Consumes `monitoring.heartbeat.node.#`, upserts nodes (liveness/resources only — never clobbers a registered name/location), derives health (3s/10s) |
| `src/nodeSelection.ts` | Pure least-loaded `selectNode` (healthy nodes, ranked by CPU+RAM load) |
| `src/agentUrl.ts` | Pure `resolveAgentUrl`/`normalizeAgentUrl` — which node's agent to call, falling back to `NODE_AGENT_URL` for single-node (#171) |
| `src/dbProvision.ts` | Pure managed-DB helpers: `isDatabaseEngine` guard + `generateDatabaseCredentials` (safe name/user/password) |
| `src/cron.ts` | Pure 5-field cron matcher (`cronMatches`, `isValidCron`) for the schedule runner |
| `src/scheduler.ts` | Schedule runner: pure `selectDue`/`tickSchedules` + `startScheduler` (1-min poll); actions injected |
| `src/users.ts` | Account domain: bcrypt hashing, email normalisation, password rules, edition-derived signup policy, and `createUserService` (register / authenticate / change password / first-run bootstrap) (#174) |
| `src/auth.ts` | `AuthProvider` seam (`createLocalAuthProvider`; FinVault JWT swaps in at #17) + `signToken`/`verifyToken` → `Principal`, `requireAuth`, `principalOf`, `requirePlatformAdmin`, and the auth/account/admin routers. **No anonymous fallback** — no token means 401 |
| `src/access.ts` | **Pure** authorization core: `Role`/`Permission`, `ROLE_PERMISSIONS`, `can`, `resolveRole`, `strongestRole`. No Express, no DB — the whole matrix is unit-tested (#175) |
| `src/accessGuard.ts` | `accessGuard(repo)` (mounted once on `/deployments/:id`; **404 for no access**, never 403) + `requirePermission(p)` per route + `accessOf(req)` |
| `src/teams.ts` | Teams (#177): `createTeamRouter` (`/teams`, membership) + `createServerTeamRouter` (`PATCH /deployments/:id/team`). Deleting a team **detaches** its servers, never deletes them |
| `src/config.ts` | `createConfigRouter` — public `GET /config` → `{ edition }` (edition flag, mounted before auth) |
| `src/api.ts` | Express deployment API: create/list/get deployments, stop/start/restart/**delete**, node health; enforces plan quotas via the Billing Bridge (hosted) |
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
| `src/pricing.ts` | Pure pricing: `BillingPlan` + `resourceFactor` (CPU/RAM → multiplier) + `billableHours`/`computeCharge` + `roundCurrency` |
| `src/quotas.ts` | Pure plan quota checks (`quotaLimit`, `withinQuota`) for servers/databases |
| `src/tracking.ts` | Pure runtime math: `hoursBetween` + `accruedHours` (open interval counts up to now) |
| `src/wallet.ts` | Pure credit-wallet math: `applyTopUp`/`applyCharge`/`canCover` |
| `src/types.ts` | Domain records + the `Repository` interface (plans, intervals, wallet, ledger, cycles) |
| `src/repository.ts` | `InMemoryRepository` — backs unit tests and a DB-less mode |
| `src/db.ts` | `getPrisma()` + `PrismaRepository` (SQLite) + `ensureDefaultPlan` seed |
| `src/service.ts` | `createBillingService` — events→intervals, wallet, and the FinVault top-up flow (`payment.request`/confirmed/failed); dependency-injected |
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
| `src/gateway.ts` | `createGatewayApp` — CORS → rate limit → JWT (protected routes) → reverse proxy (fetch) to the matched backend; injectable seams for tests |
| `src/index.ts` | Entry: builds the app for `ORCHESTRATOR_URL`, heartbeat, listens `:9400`. WS terminal proxy pending (#69/#71) |
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
| `src/gameSpec.ts` | Pure `buildGameDeployment` — maps the game picker to a real image + startup env/port (Minecraft/Valheim/Rust/CS2) |
| `src/pages/Preferences.tsx` | Preferences page — edit/save/reset the New Deployment defaults |
| `src/pages/NodeDetail.tsx` | Per-node view (`/nodes/:id`): live CPU/RAM meters + session sparkline, hosted deployments, deregister |
| `src/routes.tsx` · `src/App.tsx` | Route table (public `/login`; the rest behind `RequireAuth` + `Layout`) wrapped in the router |
| `src/components/{Layout,RequireAuth}.tsx` | Nav shell + auth-guard route wrapper |
| `src/components/InfoHint.tsx` | Accessible "?" tooltip for contextual option help (hover/focus); used across the option forms |
| `src/components/Terminal.tsx` | xterm.js interactive terminal (#71) — dynamically imports xterm, connects the exec WebSocket (`terminalWsUrl`); mounted by the server-detail Terminal tab |
| `src/components/IntroTour.tsx` | First-run intro walkthrough (skippable, re-openable from the nav Help button) |
| `src/pages/{Login,Overview,NewDeployment,Servers}.tsx` | Login, node health/overview (+ Platform-services strip from Control Room monitoring, #157), deployment form, live server list + stop |
| `src/pages/Billing.tsx` | Billing page (hosted only): credit balance, top-up via FinVault, cycle usage/cost, payment history — route + nav link gated on `useEdition().isHosted` |
| `src/health.ts` | Status → colour helpers shared across pages |
| `src/test/setup.ts` · `vitest.config.ts` | jsdom + Testing Library setup; in-memory localStorage |
| `Dockerfile` · `nginx.conf` | Static build served by nginx, which proxies `/api` to the orchestrator |

### Infrastructure
| Path | Contents |
|---|---|
| `docker-compose.yml` | RabbitMQ + control-room + node-agent + orchestrator + dashboard stack |
| `vitest.workspace.ts` | Splits tests into `backend` (node) and `dashboard` (jsdom) projects |
| `.env.example` | Env contract — documents the FinVault-shared vars (`RABBITMQ_URL`, `FINVAULT_MESSAGE_KEY`) |
| `deploy/install.sh` · `deploy/install.ps1` | Release installer: picks an edition, generates `JWT_SECRET`/`INTERNAL_API_TOKEN`/admin password, writes `.env`, starts the stack. Never overwrites an existing `.env` unasked (#192) |
| `deploy/community/` · `deploy/hosted/` | Self-contained release bundles: compose pinned to published images + `.env.example` + README. Neither needs a checkout of this repo; both are attached to each GitHub release (#179) |
| `.github/workflows/release.yml` | On a `v*` tag: re-run CI in both editions, then publish `nexusinfra-<service>:X.Y.Z-{community,hosted}` to GHCR. The dashboard is edition-neutral (one tag); `billing-bridge` builds hosted only (#179) |
| `.github/workflows/ci.yml` | CI: npm ci → build → lint (if present) → test, on PRs and pushes to dev/staging/main |
| `eslint.config.js` | Flat ESLint config (typescript-eslint recommended) covering all workspaces |

### docs/
| Path | Contents |
|---|---|
| `docs/architecture.md` | Services as built, event bus topology, routing keys in use, status model |
| `docs/security.md` | Payload encryption, secrets handling, auth plan, known gaps |
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
- **The dashboard's `permissions.ts` is a mirror, not a second source of truth.** It exists so the
  panel doesn't offer buttons that would 403; change it in the same commit as `access.ts` or the two
  drift. Hiding a control is never a security measure — the API is.
- Heartbeat cadence: 1s pulse; Control Room thresholds: degraded ≥3s, offline ≥10s.
- All timestamps are UTC ISO-8601 strings in event payloads.
- Dockerfiles build from the **repo root** context (they copy `shared/` + the service dir).
