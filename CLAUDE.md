# NexusInfra — CLAUDE.md

Infrastructure & server-management platform: TypeScript (Node.js, ESM) backend services + React dashboard
+ Docker-orchestrating node agents. Integrates with FinVault for usage-based billing over RabbitMQ.
This file is **context + rules only** — all tasks and progress live in [TODO.md](TODO.md).

Design source of truth: [`../CONCEPTS/infrastructure-platform/`](../CONCEPTS/infrastructure-platform/)
and [`../CONCEPTS/integration/`](../CONCEPTS/integration/).

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
| Orchestrator API | http://localhost:9200 (login `admin`/`admin`) |

## 7. Codebase map — where is what

### shared (event contract + messaging)
| Path | Contents |
|---|---|
| `shared/src/events.ts` | Event union, envelope, AES-256-GCM payload encryption — **wire-compatible with FinVault** (same algorithm, KDF salt, envelope shape) |
| `shared/src/rabbitmq.ts` | Connect/publish/consume helpers targeting the shared `finvault.events` topic exchange + `finvault.events.dlx` |
| `shared/src/heartbeat.ts` | `startHeartbeat(name)` (service pulse) + `startNodeHeartbeat(nodeId, collectResources)` (node pulse, resources every 5s); both take an injectable publisher |
| `shared/src/events.test.ts` | Wire-compatibility guard tests (encryption round-trip, ciphertext layout, envelope shape) |

### services/control-room (heartbeat monitoring)
| Path | Contents |
|---|---|
| `src/index.ts` | HTTP `/health` + `/status`, consumes `monitoring.heartbeat.#`, healthy→degraded(3s)→offline(10s) tracking |
| `Dockerfile` | Multi-stage workspace build (pattern shared by all services) |

### services/node-agent (Docker host agent)
| Path | Contents |
|---|---|
| `src/runtime.ts` | `ContainerRuntime` interface + `DockerodeRuntime` (real Docker via dockerode) + host resource collection + per-container log/stats streams |
| `src/stats.ts` | `parseDockerStats` — pure derivation of `ContainerStats` (CPU%, mem, network) from a Docker stats sample |
| `src/limits.ts` | `resourceLimitsToHostConfig` — pure translation of a server's `ResourceLimits` (%) into Docker HostConfig caps (Memory, NanoCpus, RestartPolicy, …) enforced at start |
| `src/files.ts` | Pure file helpers: `normalizeContainerPath` (traversal guard), `parseLsOutput`, `buildTarball` |
| `src/fileRoutes.ts` | `createFileRouter` — internal container-file CRUD HTTP (list/read/write/mkdir/rename/delete) over the runtime |
| `src/agent.ts` | Command handling: consumes server.start/stop/restart for this node, publishes server.started/stopped/crashed; dependency-injected for testing |
| `src/agent.test.ts` | Unit tests with a fake runtime + captured publisher (no Docker/broker needed) |
| `src/index.ts` | Entry: DockerodeRuntime + agent, binds `nexusinfra.node-agent.{nodeId}`, HTTP `/health` + internal SSE `/logs/:containerId` · `/stats/:containerId` + file CRUD (`fileRoutes`) |

### services/orchestrator (deployment control plane)
| Path | Contents |
|---|---|
| `prisma/schema.prisma` | Prisma + SQLite schema: `Node`, `ServerConfig`, `Deployment`, `DeploymentEvent`. `prisma/migrations` is the schema source of truth |
| `src/types.ts` | Domain records + the `Repository` interface (decouples logic from the DB) |
| `src/repository.ts` | `InMemoryRepository` — backs unit tests and a DB-less local mode |
| `src/db.ts` | `getPrisma()` + `PrismaRepository` (SQLite-backed `Repository`) |
| `src/nodeRegistry.ts` | Consumes `monitoring.heartbeat.node.#`, upserts nodes, derives health (3s/10s) |
| `src/nodeSelection.ts` | Pure least-loaded `selectNode` (healthy nodes, ranked by CPU+RAM load) |
| `src/api.ts` | Express deployment API: create/list/get deployments, stop, node health |
| `src/lifecycle.ts` | Consumes `infra.server.started/stopped/crashed`, updates deployment status + audit |
| `src/index.ts` | Entry: PrismaRepository + consumers on `nexusinfra.orchestrator`, mounts API, HTTP `/health` (`:9200`) |
| `src/*.test.ts` | Unit tests with the in-memory repo + captured publisher (no Docker/broker/DB needed) |
| `Dockerfile` | Multi-stage build; runtime applies `prisma migrate deploy` then starts |

### dashboard (React web panel)
| Path | Contents |
|---|---|
| `src/api.ts` | Typed Orchestrator client (login, nodes, deployments, create, stop); attaches the JWT; `ApiError` on non-2xx |
| `src/session.ts` | Token get/set/clear + `isAuthenticated` (single place that touches localStorage) |
| `src/routes.tsx` · `src/App.tsx` | Route table (public `/login`; the rest behind `RequireAuth` + `Layout`) wrapped in the router |
| `src/components/{Layout,RequireAuth}.tsx` | Nav shell + auth-guard route wrapper |
| `src/pages/{Login,Overview,NewDeployment,Servers}.tsx` | Login, node health/overview, deployment form, live server list + stop |
| `src/health.ts` | Status → colour helpers shared across pages |
| `src/test/setup.ts` · `vitest.config.ts` | jsdom + Testing Library setup; in-memory localStorage |
| `Dockerfile` · `nginx.conf` | Static build served by nginx, which proxies `/api` to the orchestrator |

### Infrastructure
| Path | Contents |
|---|---|
| `docker-compose.yml` | RabbitMQ + control-room + node-agent + orchestrator + dashboard stack |
| `vitest.workspace.ts` | Splits tests into `backend` (node) and `dashboard` (jsdom) projects |
| `.env.example` | Env contract — documents the FinVault-shared vars (`RABBITMQ_URL`, `FINVAULT_MESSAGE_KEY`) |
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
- Heartbeat cadence: 1s pulse; Control Room thresholds: degraded ≥3s, offline ≥10s.
- All timestamps are UTC ISO-8601 strings in event payloads.
- Dockerfiles build from the **repo root** context (they copy `shared/` + the service dir).
