# NexusInfra — TODO

Working checklist, grouped per branch. Rules live in [CLAUDE.md](CLAUDE.md).
Every actionable item carries its GitHub issue ref `(#N)`.

---

## Active — `feature/orchestrator`

Phase 2 (Core), second half: the Orchestrator — node registry, deployment planning, and lifecycle
tracking. Persistence lands first since the rest builds on it.

- [x] Persistence layer for nodes and deployments (#14)
- [x] Orchestrator: node registry (#11)
- [x] Orchestrator: deployment API with resource-aware node selection (#12)
- [ ] Orchestrator: server lifecycle event handling (#13)

> **▶ Resume marker (MVP: Orchestrator + Dashboard, plan `i-want-you-to-binary-flame`)**
> Building the MVP server panel: Orchestrator backend (this branch) then a React/Vite dashboard
> (`feature/dashboard`) with stub JWT login. Working on branch **`feature/orchestrator`** (off `dev`).
>
> **Done & pushed** on this branch:
> - A1 #14 — `services/orchestrator` workspace, Prisma+SQLite schema + migration, `Repository`
>   interface, `InMemoryRepository`/`PrismaRepository`, contract tests.
> - A2 #11 — `nodeRegistry.ts` (consumes `monitoring.heartbeat.node.#`, health thresholds) + tests.
> - A3 #12 — `nodeSelection.ts` (least-loaded) + `api.ts` (POST/GET `/deployments`, stop, `/nodes`) + tests.
>   *(committed next.)*
>
> **Next up (resume here):**
> - A4 #13 — `lifecycle.ts` (consume `server.started/stopped/crashed` → update deployment) + `index.ts`
>   wiring (connect broker, start consumers on queue `nexusinfra.orchestrator`, mount API, heartbeat, `/health`).
> - A5 — `Dockerfile`, add `orchestrator` to `docker-compose.yml`, docs (`docs/api.md`,
>   `docs/architecture.md`, CLAUDE.md §7 map), then `npm run build && lint && test` green → PR to `dev`
>   (`Closes #11 #12 #13 #14`, each on its own line) → wait for CI → move group to Done.
>
> **Then Part B — `feature/dashboard`** (branch off `dev` after A merges): B1 #15 Vite+React scaffold;
> B2 new stub-login issue (`auth.ts` JWT `/auth/login` + `requireAuth` on orchestrator, Login page);
> B3 #16 Overview + New Deployment form + Servers list (poll status). Ports: control-room 9000,
> node-agent 9100, orchestrator **9200**, dashboard (Vite) 5173.
>
> **Verify loop:** `docker-compose up rabbitmq control-room node-agent orchestrator` → dashboard login →
> deploy `nginx` `8080:80` → `docker ps` shows it, `GET :9200/deployments` = running, `curl :8080` works,
> Stop flips it to stopped.

---

## Backlog

### Phase 3 — Dashboard (`feature/dashboard`)

- [ ] Web dashboard scaffold (Vite + React + TypeScript) (#15)
- [ ] Dashboard: server overview and deployment form (#16)
- [ ] Real-time container log streaming via WebSocket (#17)
- [ ] API Gateway: JWT validation, routing, WebSocket proxy (#20)

### Phase 4 — Billing integration (`feature/billing-bridge`)

- [ ] Billing Bridge: runtime tracking and pricing tiers (#18)
- [ ] Billing Bridge: payment flow with FinVault and suspension (#19)

### Phase 5 — Production (`feature/production`)

- [ ] Production hardening: multi-node, Grafana, security, prod compose (#21)

---

## Done

### `feature/node-agent` — merged in #24

- [x] Node Agent: Docker container lifecycle via Docker API (#9)
- [x] Node Agent: heartbeat and resource reporting (#10)

### `feature/ci` — merged in #23

- [x] Add GitHub Actions CI workflow (build + test) (#6)
- [x] Add ESLint configuration for all workspaces (#7)
- [x] Scaffold docs/ (architecture, security, deployment, api) (#8)

### `feature/foundation` — merged in #22

- [x] Add CLAUDE.md workflow rules and TODO.md task tracking (#5)
- [x] Scaffold TypeScript monorepo tooling (#1)
- [x] Build shared messaging package wire-compatible with FinVault (#2)
- [x] Build Control Room heartbeat monitoring service (#3)
- [x] Write repo README quickstart (#4)
