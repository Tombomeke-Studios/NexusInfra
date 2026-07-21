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

> **The MVP server panel is complete and verified running end to end.**
> `docker-compose up` brings up RabbitMQ + Control Room + Node Agent + Orchestrator + dashboard; the
> dashboard is at **http://localhost:8095** (`admin` / `admin`). Verified live: deploying `nginx`
> starts a real container (**running**), and **Stop** removes it (**stopped**); an in-use host port
> is reported as **crashed** with the exact Docker reason.
>
> **Ports** — Control Room `9000` · Node Agent `9100` · Orchestrator `9200` · dashboard `8095`
> (Docker) / `5173` (Vite dev).
>
> **Active work:** the MVP is functional; current focus is a **UI overhaul + UX features** (see below).

---

## Active — `feature/ui-overhaul`

Make the panel look and feel professional: a real design system (tokens + light/dark theme), polished
components and pages, plus a couple of UX features. Small units, one issue + one commit each.

**Design system & components**
- [x] UI: design tokens + global stylesheet (light/dark theme) (#41)
- [x] UI: base component styles — buttons, inputs, cards, badges, table (#42)

**Pages & shell**
- [x] UI: restyle the app shell — top nav, brand, theme toggle, sign out (#43)
- [x] UI: restyle the Login page (#44)
- [x] UI: restyle the Overview page — stat cards + node tiles (#45)
- [x] UI: restyle the New Deployment form (#46)
- [x] UI: restyle the Servers table + row actions (#47)

**Features**
- [x] feat: restart endpoint (#48) + dashboard restart action
- [x] feat: deployment detail view with the event/audit trail (#49)
- [x] UI: toast notifications for actions (#50)

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

### 🐛 Fixes

- [x] Orchestrator container crashed: Prisma engine on Alpine → Debian slim + openssl (#36, merged #37)

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
