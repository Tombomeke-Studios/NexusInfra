# NexusInfra — TODO

Working checklist, grouped per branch. Rules live in [CLAUDE.md](CLAUDE.md).
Every actionable item carries its GitHub issue ref `(#N)`.

---

## Active — `feature/dashboard`

Phase 3 (Dashboard): the React/Vite web panel that drives the Orchestrator, plus a stub JWT login so
it has a user identity (the full API Gateway / FinVault-JWT integration, #20, stays backlog).
Small units, one issue + one commit each.

- [ ] Web dashboard scaffold (Vite + React + TypeScript) + root workspace wiring (#15)
- [ ] Dashboard: test + lint tooling — Vitest/jsdom, Testing Library, ESLint JSX (#27)
- [ ] Dashboard: typed Orchestrator API client (#28)
- [ ] Orchestrator: stub JWT `/auth/login` endpoint + `requireAuth` middleware (#26)
- [ ] Dashboard: app shell — routing + nav layout (#29)
- [ ] Dashboard: login page + token storage + auth guard (#30)
- [ ] Dashboard: server overview page — node health tiles + active count (#16)
- [ ] Dashboard: New Deployment form page (#31)
- [ ] Dashboard: Servers list page with status polling + stop (#32)
- [ ] Dashboard: Dockerfile + docker-compose service (#33)
- [ ] Dashboard: run docs — README, api.md auth, CLAUDE map (#34)

> **▶ Resume marker (MVP: Orchestrator + Dashboard, plan `i-want-you-to-binary-flame`)**
> Building the MVP server panel. **Part A (Orchestrator) is DONE and merged** (PR #25 → `dev`).
> Now on **Part B**, branch **`feature/dashboard`** (off `dev`).
>
> **Part B units (each = its own issue + its own small commit; see the checklist above):**
> #15 scaffold → #27 tooling → #28 API client → #26 orchestrator auth (`src/auth.ts`,
> `POST /auth/login` + `requireAuth` on `/deployments*`+`/nodes`) → #29 app shell → #30 login page →
> #16 overview → #31 deployment form → #32 servers list (poll + stop) → #33 Dockerfile/compose →
> #34 docs. Finish: build+lint+test green → PR to `dev` (one `Closes #N` per unit) → CI → merge.
>
> Ports: control-room 9000, node-agent 9100, orchestrator **9200**, dashboard (Vite) **5173**.
>
> **Verify loop:** `docker-compose up rabbitmq control-room node-agent orchestrator` +
> `npm --workspace dashboard run dev` → login → deploy `nginx` `8080:80` → `docker ps` shows it,
> Servers page = running, `curl :8080` works, Stop flips it to stopped.

> Out of MVP scope (stay in backlog): real-time log streaming (#17), API Gateway + FinVault JWT (#20).

---

## Backlog

Backlog items get their own GitHub issue at the latest when their group is promoted to an active
`feature/<topic>` branch (bugs get one immediately). Items without a `(#N)` still need one created.

### Phase 3 — Dashboard, later slices (after the MVP dashboard merges)

- [ ] Real-time container log streaming via WebSocket (#17)
- [ ] API Gateway: JWT validation, routing, WebSocket proxy (#20)
- [ ] Dashboard: server restart action (emit `infra.server.restart`)
- [ ] Dashboard: deployment detail view with the event/audit trail
- [ ] Dashboard: node detail view (resource history)
- [ ] Replace stub login with real FinVault JWT via the Gateway

### Phase 4 — Billing integration (`feature/billing-bridge`)

- [ ] Billing Bridge: service scaffold + Prisma schema (billing_plans, server_billing, billing_cycles) (#18)
- [ ] Billing Bridge: runtime tracking from `deployment.started`/`deployment.stopped` (#18)
- [ ] Billing Bridge: pricing tiers + free-hours/credit model (#18)
- [ ] Billing Bridge: periodic `payment.request` to FinVault at cycle end (#19)
- [ ] Billing Bridge: consume `payment.confirmed`/`payment.failed`; suspend on failure (#19)
- [ ] Orchestrator: consume `billing.server.suspend` → stop the user's servers
- [ ] Billing Bridge: monthly `invoice.generate`
- [ ] Dashboard: Billing page (cost breakdown, payment history, credit balance)

### Phase 5 — Production hardening (`feature/production`)

- [ ] Multi-node: run several node-agents; verify resource-aware placement across them (#21)
- [ ] Node Agent: auto-restart on crash + offline command queue/replay on reconnect
- [ ] Control Room: uptime %/history + alerting via the Notification/Mail service + DLQ monitoring
- [ ] Metrics: InfluxDB + Grafana dashboards
- [ ] Security: secrets handling, rate limiting, service-to-service auth, HTTPS
- [ ] Production docker-compose + deployment docs; migrate SQLite → PostgreSQL via Prisma
- [ ] Integration tests: RabbitMQ/DB-backed end-to-end (Docker Compose test target)

---

## Done

### `feature/orchestrator` — merged in #25

- [x] Persistence layer for nodes and deployments (#14)
- [x] Orchestrator: node registry (#11)
- [x] Orchestrator: deployment API with resource-aware node selection (#12)
- [x] Orchestrator: server lifecycle event handling (#13)

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
