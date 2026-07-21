<div align="center">

# 🗺️ NexusInfra — Roadmap & TODO

![MVP](https://img.shields.io/badge/MVP-complete-16a34a?style=flat-square)
![Phase](https://img.shields.io/badge/current-Phase_2_·_Core-3b82f6?style=flat-square)
![Tests](https://img.shields.io/badge/tests-60_passing-6e9f18?style=flat-square)
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
> **Active work:** UI motion & micro-interactions polish (see below).

---

## Active — `feature/ui-animations`

Add tasteful, performant motion (transform/opacity, 150–300ms, `prefers-reduced-motion` respected).
Small units, one issue + one commit each.

- [ ] UI motion: foundation — keyframes, utilities, `motionEnabled()` helper (#57)
- [x] UI motion: animated route/page transitions (#58)
- [x] UI motion: Overview — count-up stats + staggered node tiles (#59)
- [x] UI motion: Servers — staggered row entrance + row transitions (#60)
- [ ] UI motion: toast enter/exit + drawer polish (#61)
- [ ] UI motion: card hover lift + interactive micro-interactions (#62)

---

## Backlog

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
