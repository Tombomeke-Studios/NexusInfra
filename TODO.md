# NexusInfra — TODO

Working checklist, grouped per branch. Rules live in [CLAUDE.md](CLAUDE.md).
Every actionable item carries its GitHub issue ref `(#N)`.

---

## Active — `feature/ci`

Tooling the workflow depends on: CI so PRs gate on green, lint so the commit rules are checkable,
docs so section 5 of CLAUDE.md has targets.

- [x] Add GitHub Actions CI workflow (build + test) (#6)
- [x] Add ESLint configuration for all workspaces (#7)
- [ ] Scaffold docs/ (architecture, security, deployment, api) (#8)

---

## Backlog

### Phase 2 — Core (`feature/node-agent`, `feature/orchestrator`)

- [ ] Node Agent: Docker container lifecycle via Docker API (#9)
- [ ] Node Agent: heartbeat and resource reporting (#10)
- [ ] Orchestrator: node registry (#11)
- [ ] Orchestrator: deployment API with resource-aware node selection (#12)
- [ ] Orchestrator: server lifecycle event handling (#13)
- [ ] Persistence layer for nodes and deployments (#14)

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

### `feature/foundation` — merged in #22

- [x] Add CLAUDE.md workflow rules and TODO.md task tracking (#5)
- [x] Scaffold TypeScript monorepo tooling (#1)
- [x] Build shared messaging package wire-compatible with FinVault (#2)
- [x] Build Control Room heartbeat monitoring service (#3)
- [x] Write repo README quickstart (#4)
