<div align="center">

# 🗺️ NexusInfra — Roadmap & TODO

![MVP](https://img.shields.io/badge/panel-feature--complete-16a34a?style=flat-square)
![Phase](https://img.shields.io/badge/next-Phase_5_·_Production-3b82f6?style=flat-square)
![Editions](https://img.shields.io/badge/editions-community_·_hosted-8b5cf6?style=flat-square)
![Tests](https://img.shields.io/badge/tests-742_passing-6e9f18?style=flat-square)
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
| **4 · Billing (2 editions)** | Open-core split (community vs hosted) + Billing Bridge ↔ FinVault, usage-based charging | ✅ Done (#144–#150) |
| **5 · Production** | Multi-node, metrics, security hardening, Postgres, API Gateway | 📋 Backlog |
| **6 · Sharing + releases** | Accounts · per-server authorization · invitations · teams · role-aware panel · per-edition release pipeline | ✅ Done (#173–#179) |
| **7 · Say only what we do** | Close the gap between what the panel claims and what it does — mock tabs, dead buttons, unreachable APIs | 🔨 Active (#217–#224) |
| **8 · Accounts & security** | Login rate limit · password reset · session revocation · API tokens · 2FA · ownership transfer | 📋 Backlog (#225–#230) |
| **9 · Depth** | Templates · backup retention · port pools · node migration · SFTP · notifications · list scale · CLI | 📋 Backlog (#231–#240) |

---

## Current state

> **⚠️ "Every tab is real" was too generous.** A repo sweep (2026-08-26) found the **Network** and
> **Startup** tabs still rendering hardcoded mock data, a Reinstall button that only toasts
> "not wired yet", an audit trail nobody can read, and the account/user-admin APIs with no page
> calling them. Phase 7 (#217–#224) closes exactly that gap. Everything below this line is accurate
> for the tabs it names.
>
> **The panel is otherwise feature-complete and those tabs are real — verified live.**
> `docker-compose up` brings up RabbitMQ + Control Room + Node Agent + Orchestrator + dashboard; the
> dashboard is at **http://localhost:8095** (sign in as `admin@local` / `ADMIN_PASSWORD`). The node-agent mounts the Docker
> socket, so all container operations run against real containers.
>
> **Verified live end to end (via the API against a real `nginx:alpine` container):** deploy → running →
> stop/start/restart; **file** list/read/**write**/mkdir/**new-file**/rename/delete; **console exec**
> (`docker exec`, with a tracked `cwd` and working `cd`); **databases** (spins up a real `postgres:16`/
> mysql container per DB); **backups** (real tar snapshot); **node** register/deregister + location;
> **live logs (SSE)** + **live stats (`docker stats`)** in the console/header.
>
> **Ports** — Control Room `9000` · Node Agent `9100` · Orchestrator `9200` · Billing Bridge `9300`
> (hosted only) · API Gateway `9400` · dashboard `8095` (Docker) / `5173` (Vite dev).
>
> **Phase 4 billing is complete (#144–#150)** — one codebase, two editions via
> `NEXUS_EDITION=community|hosted` (default `community`). Community is the standalone manager with no
> billing/FinVault; hosted adds resource-scaled usage pricing, plan quotas, a prepaid credit wallet
> topped up via FinVault, a monthly cycle runner and suspend-on-empty-balance. Design:
> **[docs/billing.md](docs/billing.md)**.
>
> **Also since:** interactive **xterm.js terminal** over a JWT-authenticated WebSocket (#71), the
> **API Gateway** HTTP core (#20 — CORS, rate limiting, JWT, reverse proxy), **Delete server** wired end
> to end (#156), Control Room health surfaced in the panel (#157) plus **uptime % / transitions** (#165).
>
> **✅ Verified live (community edition, from the release bundle):** the whole stack started from
> published-image compose, every service reported `edition: community`, and the sharing flow was
> walked end to end against a real `nginx:alpine` container — a stranger got **404** (not 403), an
> **operator stopped and started the container for real** while being refused files-write, backups,
> databases, subusers, delete and node registration, a **viewer** was refused control but could still
> look, and **revoking access took effect on the next request**. Self-registration was refused in
> community, and the served dashboard bundle contained **no billing code**.
>
>  **⚠️ Still not verified live:** the terminal's PTY/WebSocket path, the gateway proxy, and the
> hosted edition (needs FinVault on a shared broker).
>
> **Phase 6 is complete (#173–#179) — the panel is multi-user and both editions are shippable.**
> Real accounts replace the single hardcoded login, and **every** server route is now authorized:
> before this, any signed-in user could stop, delete or open a root shell in anyone's container.
> Access comes from ownership, a per-server invitation, or team membership, with roles
> **viewer → operator → admin → owner**; no access answers 404 rather than 403 so server ids cannot
> be probed. Invitations can be sent to people who have no account yet and stay inert until claimed.
> The panel splits **My servers** / **Shared with me** and offers only actions the caller's role
> allows. Model: **[docs/security.md](docs/security.md)**.
>
> **Releases.** Tagging `vX.Y.Z` publishes `nexusinfra-<service>:X.Y.Z-{community,hosted}` to GHCR and
> attaches **one archive** containing both editions plus an installer (#191). **The image decides its
> edition** (#189): pulling `:hosted` is enough, and a service asked to run as the edition it was not
> built for exits rather than half-enabling billing. The community dashboard genuinely **does not
> contain** the billing code, checked against the built bundle at image-build time (#190).
> See **[docs/deployment.md](docs/deployment.md)**.
>
> **Next up — Phase 5 production hardening.** Remaining work is mostly environment-dependent
> (multi-node, Postgres, metrics, HTTPS) or blocked on FinVault (#17 real JWT).
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
- [x] Subusers — per-server access management (invite/role/revoke); **enforced since #175** (#112)
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

### Phase 4 — Billing, as two editions (open-core) — ✅ done

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

- [~] WebSocket transport for a persistent exec/terminal session (JWT) (#69 — **console/terminal over WS done**; logs/stats still SSE)
- [x] Dashboard: full interactive terminal (xterm.js, persistent PTY) for a server (#71)
- [~] API Gateway: JWT validation, routing, WebSocket proxy (#20) — **HTTP core done** (CORS, rate limit, JWT, reverse proxy, `:9400`); WS proxy pending with the terminal
- [ ] Replace stub login with real FinVault JWT via the Gateway (#17, #20)

### Phase 6 — Multi-user sharing + two shippable editions

> **The two products, made real.** NexusInfra ships as a **standalone self-hosted panel**
> (community) and a **multi-tenant hosted instance** (hosted, FinVault billing on). Two things block
> both: there are no real users (one hardcoded `admin`, and *no authorization at all* — every valid
> JWT can stop, delete or open a root terminal in anyone's container), and there is no release
> pipeline. Roles are **admin / operator / viewer** above the owner; sharing works per-server **and**
> via teams; accounts are local, with signup policy following the edition.
> Build **in order** — each is a feature branch + PR.

- [x] Edition flag never reached the orchestrator — `/config` always said `community` (#173) 🐛
- [x] Real user accounts — password login, edition-dependent signup, no anonymous fallback (#174)
- [x] Access control — per-server roles enforced on every deployment route + the terminal WS (#175)
- [x] Subuser invites bound to real accounts (pending until claimed) + `operator` role (#176)
- [x] Teams — account-level sharing of servers (#177)
- [x] Role-aware dashboard — "Shared with me" + actions gated by permission (#178)
- [x] Release pipeline — per-edition images on GHCR + `deploy/{community,hosted}` bundles (#179)
- [x] Per-edition images decide their own edition; mismatch refuses to start (#189)
- [x] Dashboard built per edition — community ships no billing code, verified against the bundle (#190)
- [x] One release archive with an installer for POSIX + Windows (#191)
- [x] Nest the image names under one `nexusinfra` namespace (#200)
- [x] Document every image for people who assemble their own stack (#201)
- [x] All-in-one image per edition — `nexusinfra-community` / `nexusinfra-hosted` (#203)
- [ ] Slim the service images — Prisma CLI + engine targets (orchestrator is 501 MB) (#192) 📋
- [x] Gateway test failed intermittently — the token was signed twice (#208) 🐛
- [x] Slim the all-in-one — build tooling no longer ships to users, 1.07 GB → 915 MB (#204)
- [x] Document the release installer, and link it from the README (#210)

### Phase 7 — Say only what we do (`feature/panel-truthfulness`)

> **The panel promises more than it delivers.** A repo sweep found two server tabs still rendering
> hardcoded mock data, a button that only fires a "not wired yet" toast, an audit trail that is
> written and never read, and two working API surfaces (account + user admin) that no page calls.
> None of this is new work in the product sense — it is closing the gap between what the UI claims
> and what the code does. Build **in order**; each is a feature branch + PR.

- [x] Network tab is hardcoded — render real port allocations, drop the fake SFTP host (#217) 🐛
- [x] Startup tab invents environment variables — show the server's own (#218) 🐛
- [x] "Reinstall server" is a no-op — removed; Start already recreates from config (#219) 🐛

**Second sweep — the panel fabricates telemetry.** Worse than the tabs: when a real stream fails,
the panel does not say so, it *invents plausible data*. A broken node shows drifting meters and
scrolling log lines describing events that never happened.

- [x] Live CPU/RAM/network are invented when the stats stream fails (#250) 🐛
- [x] The console invents log lines when the log stream fails (#251) 🐛
- [x] Player count and TPS are fabricated for every game server (#252) 🐛 — tiles removed
- [x] Kill button is a no-op — unlike Reinstall, this one is worth building (#253) 🐛
- [x] Placement picker is ignored — a pinned node is silently overruled (#254) 🐛
- [x] The startup command field is never sent anywhere (#255) 🐛 — field removed
- [x] Feature limit sliders (databases/backups) are never sent or enforced (#256) 🐛 — section removed
- [x] Node maintenance mode exists only in the browser tab — servers still land there (#258) 🐛
- [x] Node cards invent a vCPU count and a committed-resources meter (#261) 🐛
- [x] Uploading a binary file silently corrupts it — bytes now travel raw (#263) 🐛
- [x] A server's config cannot be edited after creation — `PATCH /deployments/:id` (#220)
- [x] Account settings page — change your own password (`/me` exists, nothing calls it) (#221)
- [x] Admin user management page — list/create accounts without curl (#222)
- [x] Expose the deployment audit trail + an Activity tab (#223)
- [x] Team routes check membership by hand — move them behind the guard layer (#224)

### Phase 8 — Accounts & security hardening

> Everything here is about what happens **after** the password: recovery, revocation, second
> factors, and the machine-to-machine path. The panel hands out root shells; today a single
> password with no rate limit is the whole defence.

- [x] Login is not rate limited on the orchestrator — nginx proxies past the gateway (#225) 🐛
- [x] Password reset flow — admin-driven; the email variant waits on the notification service (#226)
- [x] Sessions cannot be revoked — a deleted user's token stays valid (#227)
- [ ] API tokens for scripted/CI access, scoped and revocable (#228)
- [ ] Two-factor authentication (TOTP) + recovery codes (#229)
- [ ] Transfer server ownership — an owner who leaves orphans their servers (#230)

### Phase 9 — Features that follow from what exists

- [x] Server templates ("eggs") — recipes with typed, validated variables; replaced `gameSpec.ts` (#231)
- [x] Import an existing server directory into the panel (#268)
- [ ] Backup retention, download, and off-site (S3) targets (#232)
- [ ] Port allocation management per node — pool, conflicts, primary port (#233)
- [ ] Migrate a server to another node (#234)
- [ ] Real SFTP access per server, honouring the file permissions (#235)
- [ ] Notification service — mail/webhook on crash, suspend, node offline (#236)
- [ ] Search, filter and pagination on the Servers list (#237)
- [ ] Bulk actions on multiple servers (#238)
- [ ] Update a deployment's container image (pull + recreate) (#239)
- [ ] `nexusctl` — a CLI client for the panel (#240)

### 🐛 Bugs / fixes (open)

- [x] Delete server button is a no-op — wire `DELETE /deployments/:id` end to end (#156)
- [x] Node Agent internal API was unauthenticated + host-published — token-guard it (#169)
- [x] Control Room not surfaced/up in the running stack — verify it starts + show its health in the panel (#157)
- [x] A server name with a space never starts — derive a Docker-safe container name (#286)
- [x] IO priority makes every container start fail on hosts without `io.weight` — detect and skip it (#288)

### Small cleanups / follow-ups

- [x] Remove the default DB engine from Preferences (engine is chosen at creation) (#150)

### Phase 5 — Production hardening (`feature/production`)

- [~] Multi-node: agent calls now route to the deployment's owning node (#171 — **done**); still to do: run several agents and verify placement across them live (#21)
- [~] Node Agent: offline event queue / replay on reconnect (#167 — **done**, in-memory outbox for lifecycle reports) + auto-restart on crash (still to do)
- [~] Control Room: uptime % / history (#165 — **done**, in-memory) + alerting via the Notification/Mail service + DLQ monitoring (still to do)
- [ ] Metrics: InfluxDB + Grafana dashboards
- [ ] Prometheus `/metrics` on every service — the cheap half of the above (#246)
- [~] Security: service-to-service auth (#169 — **done**, token-guarded agent API) + rate limiting (done in the gateway, #20); secrets-at-rest, token rotation, mTLS/HTTPS still to do
- [ ] Production docker-compose + deployment docs; migrate SQLite → PostgreSQL via Prisma (#241)
- [ ] Integration tests: RabbitMQ / DB-backed end to end (Docker Compose test target) (#242)
- [x] Nothing watches the dead-letter queue — surfaces DLQ depth in the panel (#243)
- [x] Node Agent does not reconcile containers after its own crash (#244)
- [x] Document TLS termination / reverse proxy — the installer ships plain HTTP (#245)
- [ ] Accessibility + small-screen audit of the panel (keyboard, focus, reduced motion) (#247)

### Small cleanups / follow-ups (open)

- [ ] `docs/billing.md` is missing from the documentation ownership table in CLAUDE.md (#248)

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

- [x] Subusers — per-server access management (invite/role/revoke); enforced since #175 (#112)

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
