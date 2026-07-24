<div align="center">

# 🗺️ NexusInfra — Roadmap & TODO

![MVP](https://img.shields.io/badge/MVP-complete-16a34a?style=flat-square)
![Phase](https://img.shields.io/badge/current-Phase_2_·_Core-3b82f6?style=flat-square)
![Tests](https://img.shields.io/badge/tests-87_passing-6e9f18?style=flat-square)
![Open issues](https://img.shields.io/github/issues/Tombomeke-Studios/NexusInfra?style=flat-square)

</div>

Working checklist and roadmap, grouped per branch. Conventions and the iteration loop live in
[CLAUDE.md](CLAUDE.md); every actionable item carries its GitHub issue ref `(#N)`.

**Legend** — `[x]` done · `[ ]` to do · ✅ merged · 📋 backlog · 🐛 bug

---

## Progress overview

| Phase | Focus | Status |
|---|---|:--:|
| **1 · Foundation** | Monorepo, `shared` event contract, Control Room, CI, docs | ✅ Done |
| **2 · Core** | Node Agent (Docker lifecycle), Orchestrator (registry · placement · lifecycle) | ✅ Done |
| **3 · Dashboard (MVP)** | React/Vite panel · stub JWT login · deploy loop end to end | ✅ Done |
| **3+ · Dashboard extras** | Live logs, API Gateway, detail views | 📋 Backlog |
| **4 · Billing** | Billing Bridge ↔ FinVault, usage-based charging | 📋 Backlog |
| **5 · Production** | Multi-node, metrics, security hardening, Postgres | 📋 Backlog |

---

## Current state

> **The MVP server panel is complete, polished, and verified running end to end.**
> `docker-compose up` brings up RabbitMQ + Control Room + Node Agent + Orchestrator + dashboard; the
> dashboard is at **http://localhost:8095** (`admin` / `admin`). The UI has a full design system
> (light/dark theme), restyled pages, plus **restart**, a **deployment detail drawer**, and **toasts**.
> Verified live end to end: **deploy → running → stop (container removed) → start again → running**,
> plus **restart**; an in-use host port surfaces as **crashed** with the exact Docker reason.
>
> **Ports** — Control Room `9000` · Node Agent `9100` · Orchestrator `9200` · dashboard `8095`
> (Docker) / `5173` (Vite dev).
>
> **Latest:** the redesign is fully ported (UI/UX present) and **making the mock features functional**
> has begun. ✅ **Live logs** and ✅ **live stats** are real — a running server's container logs stream
> to the Console tab and its CPU/memory/network stream from real `docker stats` to the header meters
> (mock fallback when no backend). **Next up:** the interactive terminal (#68/#71), then the
> panel-feature backlog below.

---

## Backlog

### Panel features → functional (make the mock UI real)

Each mock behavior in the ported design becomes real, one issue + branch at a time.

- [x] Persist full deployment config (limits, restart, env, kind) (#106)
- [x] Enforce resource limits / restart policy / OOM at container start (#107)
- [ ] File management API + real Files tab (#108)
- [ ] Server databases — provision real DBs (#109)
- [ ] Server backups — snapshot & restore volumes (#110)
- [ ] Server schedules — cron tasks (#111)
- [ ] Subusers — per-server access control (#112, needs #20)
- [ ] Node provisioning — register/deregister real nodes (#113)
- [ ] Game servers — real game images + startup (#114)

### Phase 3+ — Live server console (logs · terminal · stats)

A per-server console like other panels: live logs, an interactive terminal, and CPU/RAM/network.
Needs a WebSocket transport (not the RabbitMQ command bus) authenticated by JWT. Big group; build
after picking it up. Depends on / overlaps the API Gateway (#20).

- [x] Node Agent: stream container logs (SSE) (#66) · Dashboard live logs (#70) — done in #115
- [x] Node Agent: per-container resource stats (docker stats) (#67) · Dashboard live stats (#72)
- [ ] Node Agent: interactive exec/console into a container (#68)
- [ ] WebSocket transport for exec/terminal (gateway, JWT) (#69 — logs/stats use SSE already)
- [ ] Dashboard: interactive terminal (xterm.js) for a server (#71)

### Phase 3+ — Dashboard, other slices

Backlog items get their own GitHub issue at the latest when their group is promoted to an active
`feature/<topic>` branch (bugs get one immediately). Items without a `(#N)` still need one created.

### Phase 3+ — Dashboard, later slices

- [ ] Real-time container log streaming via WebSocket (#17)
- [ ] API Gateway: JWT validation, routing, WebSocket proxy (#20)
- [ ] Dashboard: node detail view (resource history)
- [ ] Replace stub login with real FinVault JWT via the Gateway

### Phase 4 — Billing integration (`feature/billing-bridge`)

- [ ] Billing Bridge: service scaffold + persistence (billing plans, server billing, cycles) (#18)
- [ ] Billing Bridge: runtime tracking from `deployment.started` / `deployment.stopped` (#18)
- [ ] Billing Bridge: pricing tiers + free-hours / credit model (#18)
- [ ] Billing Bridge: periodic `payment.request` to FinVault at cycle end (#19)
- [ ] Billing Bridge: consume `payment.confirmed` / `payment.failed`; suspend on failure (#19)
- [ ] Orchestrator: consume `billing.server.suspend` → stop the user's servers
- [ ] Billing Bridge: monthly `invoice.generate`
- [ ] Dashboard: Billing page (cost breakdown, payment history, credit balance)

### Phase 5 — Production hardening (`feature/production`)

- [ ] Multi-node: run several node agents; verify resource-aware placement across them (#21)
- [ ] Node Agent: auto-restart on crash + offline command queue / replay on reconnect
- [ ] Control Room: uptime % / history + alerting via the Notification/Mail service + DLQ monitoring
- [ ] Metrics: InfluxDB + Grafana dashboards
- [ ] Security: secrets handling, rate limiting, service-to-service auth, HTTPS
- [ ] Production docker-compose + deployment docs; migrate SQLite → PostgreSQL via Prisma
- [ ] Integration tests: RabbitMQ / DB-backed end to end (Docker Compose test target)

---

## Done

### `feature/enforce-limits` — merged in #119 (make the mock UI real)

- [x] Enforce resource limits / restart policy / OOM at container start (#107)

### `feature/persist-config` — merged in #118 (make the mock UI real)

- [x] Persist full deployment config — typed resource limits, restart policy, kind (#106)

### `feature/live-stats` — merged in #117 (live per-server stats)

- [x] Node Agent: per-container resource stats (`GET /stats/:containerId`, SSE) (#67)
- [x] Orchestrator: proxy `GET /deployments/:id/stats` to the owning node agent
- [x] Dashboard: header meters stream real `docker stats`, mock fallback (#72)

### `feature/live-logs` — merged in #115 (first functional slice)

- [x] Node Agent: stream container logs (`GET /logs/:containerId`, SSE) (#66)
- [x] Orchestrator: proxy `GET /deployments/:id/logs` to the owning node agent (part of #69)
- [x] Dashboard: Console tab streams real logs, falls back to mock (#70)

### `feature/design-polish` — merged in #101

- [x] Cursor aura trail + FX parity (#93) · toast heading + message (#99) · option/tab hover states (#100)
- [x] Live streaming console (#96) · navigable Files tree (#97) · interactive detail actions (#98)
- [x] New Deployment headroom + game form (#95) · Overview live meters + add-node form + node actions (#94)

### `feature/design-copy` — merged in #92

- [x] Foundation: aurora/grid tokens + keyframes + range sliders (#74) · aurora background (#75)
- [x] Interaction layer — ripple/burst/spotlight/magnetic + richer toasts (#91)
- [x] Screens: Login (#76), shell (#77), Overview (#78), New Deployment (#79), Servers (#80)
- [x] Server detail (#81) + tabs: Console (#82), Files (#83), Databases (#84), Backups (#85),
      Network (#86), Schedules (#87), Subusers (#88), Startup (#89), Settings (#90)

### `feature/ui-animations` — merged in #65

- [x] Motion foundation (#57) · route transitions (#58) · Overview count-up + stagger (#59)
- [x] Servers row stagger (#60) · toast + drawer enter/exit (#61) · hover/press micro-interactions (#62)

### 🐛 Fixes (recent)

- [x] Node Agent removes a leftover same-named container before start (idempotent) (#63, merged #64)

### `feature/start-server` — merged in #55

- [x] Start (re-run) a stopped/crashed deployment from the panel — `POST /deployments/:id/start` + action (#54)
- [x] Node Agent removes the container on stop (frees name/ports, enables clean start) (#52)

### 🐛 Fixes

- [x] Dashboard 501 in some browsers: move published port off 8090 → 8095 (#39, merged #40)
- [x] Orchestrator container crashed: Prisma engine on Alpine → Debian slim + openssl (#36, merged #37)

### `feature/ui-overhaul` — merged in #51

- [x] Design tokens + light/dark theme (#41) · base component styles (#42)
- [x] Restyled shell (#43), Login (#44), Overview (#45), New Deployment (#46), Servers (#47)
- [x] Restart endpoint + action (#48) · deployment detail drawer (#49) · toasts (#50)

### `feature/dashboard` — merged in #35

- [x] Web dashboard scaffold (Vite + React + TypeScript) + workspace wiring (#15)
- [x] Test + lint tooling — Vitest/jsdom, Testing Library (#27)
- [x] Typed Orchestrator API client (#28)
- [x] Orchestrator: stub JWT `/auth/login` + `requireAuth` middleware (#26)
- [x] App shell — routing + nav layout (#29)
- [x] Login page + token storage + auth guard (#30)
- [x] Server overview page — node health tiles + active count (#16)
- [x] New Deployment form page (#31)
- [x] Servers list page with status polling + stop (#32)
- [x] Dashboard Dockerfile + docker-compose service (#33)
- [x] Run docs — README, api.md auth, CLAUDE map (#34)

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
