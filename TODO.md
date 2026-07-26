<div align="center">

# 🗺️ NexusInfra — Roadmap & TODO

![MVP](https://img.shields.io/badge/panel-feature--complete-16a34a?style=flat-square)
![Phase](https://img.shields.io/badge/next-Phase_5_·_Production-3b82f6?style=flat-square)
![Tests](https://img.shields.io/badge/tests-250_passing-6e9f18?style=flat-square)
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
| **3+ · Panel functional + UX** | Every mock tab made real (files/db/backups/schedules/subusers/console/nodes/games) + tooltips, intro, prefs, node detail | ✅ Done |
| **4 · Billing (2 editions)** | Open-core split (community vs hosted) + Billing Bridge ↔ FinVault, usage-based charging | ✅ Done (#144–#149) · #150 cleanup left |
| **5 · Production** | Multi-node, metrics, security hardening, Postgres, API Gateway | 📋 Backlog |

---

## Current state

> **The panel is feature-complete and every tab is real — verified live.**
> `docker-compose up` brings up RabbitMQ + Control Room + Node Agent + Orchestrator + dashboard; the
> dashboard is at **http://localhost:8095** (`admin` / `admin`). The node-agent mounts the Docker
> socket, so all container operations run against real containers.
>
> **Verified live end to end (via the API against a real `nginx:alpine` container):** deploy → running →
> stop/start/restart; **file** list/read/**write**/mkdir/**new-file**/rename/delete; **console exec**
> (`docker exec`, with a tracked `cwd` and working `cd`); **databases** (spins up a real `postgres:16`/
> mysql container per DB); **backups** (real tar snapshot); **node** register/deregister + location;
> **live logs (SSE)** + **live stats (`docker stats`)** in the console/header.
>
> **Ports** — Control Room `9000` · Node Agent `9100` · Orchestrator `9200` · dashboard `8095`
> (Docker) / `5173` (Vite dev).
>
> **Next up — Phase 4 billing, as TWO editions (open-core):** the current app is the **community**
> (standalone, free) edition. A **hosted** edition adds usage-based billing via FinVault behind an
> edition flag — because paying for servers you host yourself makes no sense; billing only fits the
> hosting-provider scenario. Full design + decisions in **[docs/billing.md](docs/billing.md)**; slices
> are issues **#144–#149** (+ small cleanup #150). **A new session should start there.**
>
> **Rebuild reminder:** after merging dashboard/service changes, the running `:8095` stack serves a
> stale image until you `docker compose up -d --build <service>`. (Cost us a "the background isn't
> there" scare — it was a 30h-old image.)

---

## Backlog

### Panel features → functional (make the mock UI real)

Each mock behavior in the ported design becomes real, one issue + branch at a time.

- [x] Persist full deployment config (limits, restart, env, kind) (#106)
- [x] Enforce resource limits / restart policy / OOM at container start (#107)
- [x] File management API + real Files tab (#108)
- [x] Server databases — provision real DBs (#109)
- [x] Server backups — snapshot & restore volumes (#110)
- [x] Server schedules — cron tasks (#111)
- [x] Subusers — per-server access management (invite/role/revoke); enforcement needs #20 (#112)
- [x] Node provisioning — register/deregister real nodes (#113)
- [x] Game servers — real game images + startup (#114)

### Panel UX & customisation

Make the panel understandable and tailorable — the options should explain themselves.

- [x] Contextual help: hover/focus tooltips explaining every option (#122)
- [x] First-run onboarding / guided intro — nodes especially (#123)
- [x] User preferences: form defaults + customisation, persisted (#124)

### Phase 3+ — Live server console (logs · exec · stats) — done

- [x] Node Agent: stream container logs (SSE) (#66) · Dashboard live logs (#70) — done in #115
- [x] Node Agent: per-container resource stats (docker stats) (#67) · Dashboard live stats (#72)
- [x] Node Agent: exec/console into a container (`POST /exec`, one-shot `sh -c`) (#68) — Console command input is real
- [x] Dashboard: node detail view (resource history) (#125)

_(The persistent-PTY terminal #69/#71 and the API Gateway #20 are listed under "remaining console /
gateway work" above.)_

### Phase 4 — Billing, as two editions (open-core) — **START HERE next session**

> **Decision:** one codebase, `NEXUS_EDITION=community|hosted` (default community). Community = the
> standalone manager we have now (no billing/FinVault). Hosted = the imagined hosting-provider scenario
> with usage billing. Full design, data model, pricing, wallet + suspend flow: **[docs/billing.md](docs/billing.md)**.
> Build the slices **in order** (each is a normal feature branch + PR):

- [x] Edition flag `community|hosted` across services + `GET /config`; dashboard hides/shows billing (#144)
- [x] `shared`: add `billing.server.suspend` + `invoice.generate` events (envelope/encryption unchanged) (#145)
- [x] `billing-bridge` service: pricing/quotas (pure, tested) + persistence + runtime tracking + credit wallet + top-up flow (#146)
- [x] `billing-bridge`: monthly cycle runner — charge credit → suspend on short balance → `invoice.generate` (#147)
- [x] Orchestrator: enforce plan quotas (max servers/databases) + consume `billing.server.suspend` → stop servers (#148)
- [x] Dashboard: **Billing** page (balance, top-up via FinVault, usage breakdown, history) — hosted only (#149)

### Phase 3+ — remaining console / gateway work

- [ ] WebSocket transport for a persistent exec/terminal session (gateway, JWT) (#69 — one-shot exec already works over HTTP)
- [ ] Dashboard: full interactive terminal (xterm.js, persistent PTY) for a server (#71)
- [ ] API Gateway: JWT validation, routing, WebSocket proxy (#20) — unblocks the terminal + real subuser enforcement
- [ ] Replace stub login with real FinVault JWT via the Gateway (#17, #20)

### 🐛 Bugs / fixes (open)

- [x] Delete server button is a no-op — wire `DELETE /deployments/:id` end to end (#156)
- [ ] Control Room not surfaced/up in the running stack — verify it starts + show its health in the panel (#157)

### Small cleanups / follow-ups

- [ ] Remove the default DB engine from Preferences (engine is chosen at creation) (#150)

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

### `feature/files-console-ux` — merged in #143 (fixes)

- [x] Fix false "New folder" API error (empty-body 2xx); add **New file**; console shows **cwd** + `cd` works (#142)

### `feature/subusers` — merged in #140 · `feature/console-exec` — #139 · `feature/node-detail` — #138

- [x] Subusers management (#112) · real Console `docker exec` (#68) · node detail view (#125)

### `feature/node-location-label` — merged in #136 (panel UX)

- [x] Node "Region" → free-form "Location" label (self-hosted; no fixed cloud regions) (#135)

### `feature/user-preferences` — merged in #130 (panel UX)

- [x] User preferences — customisable New Deployment defaults, persisted; seeds the forms (#124)

### `feature/onboarding-intro` — merged in #127 (panel UX)

- [x] First-run onboarding / guided intro — nodes-first, re-openable from Help (#123)

### `feature/contextual-help` — merged in #126 (panel UX)

- [x] Contextual help — accessible hover/focus tooltips explaining every option (#122)

### `feature/subusers` — merged in #140 (make the mock UI real)

- [x] Subusers — per-server access management (invite/role/revoke); enforcement pending #20 (#112)

### `feature/console-exec` — merged in #139 (make the mock UI real)

- [x] Console command input is real — one-shot `docker exec` (`sh -c`) with output (#68)

### `feature/node-detail` — merged in #138 (panel UX)

- [x] Node detail view — live meters + session sparkline, hosted deployments, deregister (#125)

### `feature/node-provisioning` — merged in #137 (make the mock UI real)

- [x] Node provisioning — register/deregister real nodes + persisted location label (#113, #135)

### `feature/game-servers` — merged in #133 (make the mock UI real)

- [x] Game servers — real game images (Minecraft/Valheim/Rust/CS2) + startup env/port (#114)

### `feature/server-schedules` — merged in #132 (make the mock UI real)

- [x] Server schedules — cron-driven restart/backup tasks, CRUD + run-now (#111)

### `feature/server-backups` — merged in #131 (make the mock UI real)

- [x] Server backups — tar snapshot/restore of a server's data volume, list/delete (#110)

### `feature/server-databases` — merged in #121 (make the mock UI real)

- [x] Server databases — provision real per-server engine containers, list/delete (#109)

### `feature/file-management` — merged in #120 (make the mock UI real)

- [x] File management API + real Files tab — CRUD over the container filesystem (#108)

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

- [x] Port the missing background node-network canvas from the design (#128, merged #129)
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
