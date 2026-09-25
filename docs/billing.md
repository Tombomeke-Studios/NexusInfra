# Billing & FinVault integration — design

Status: **design / to build** (Phase 4). This captures *how* NexusInfra charges for usage and links to
FinVault. The payment event contract (`payment.request/confirmed/failed`) already exists in
`shared/events.ts`, wire-compatible with FinVault over the shared `finvault.events` exchange. Product
decisions below were made with the user; see
[`../../CONCEPTS/integration/billing-bridge.md`](../../CONCEPTS/integration/billing-bridge.md) for the
cross-project design.

## Two editions (decided)

Charging for servers you host **yourself** makes no sense — billing only applies when the person using
the panel is **not** the owner of the hardware (a hosting-provider scenario). So NexusInfra ships as
**one codebase with an edition flag**, not two forks (open-core pattern, cf. GitLab CE/EE):

| | **Community** (default) | **Hosted** ("paid") |
|---|---|---|
| Use case | Self-hosted manager, à la Pterodactyl | Imagined multi-tenant hosting provider |
| Billing / FinVault | **off** | **on** |
| Credit wallet, top-ups, quotas-with-payment | hidden | active |
| Billing page in the dashboard | hidden | shown |
| Billing Bridge service | not run | runs |

- **Edition flag:** `NEXUS_EDITION=community|hosted` (services) + the dashboard reads it from a small
  public config endpoint (e.g. `GET /config` → `{ edition }`) so the Billing page / usage badges only
  render in `hosted`. Default is `community` — the standalone manager stays clean and fully usable.
- Everything below (pricing, wallet, cycle, events) is the **hosted** edition. Community mode simply
  doesn't load any of it and has no FinVault dependency.

## Model — hosted edition (decided)

- **Usage-based, resource-scaled pricing.** Cost per server = runtime hours × a base hourly rate ×
  a resource factor derived from the server's chosen CPU/RAM limits. Rates live in `billing_plans` so
  they're tunable without a code change.
- **Quotas per plan.** A plan also caps **how many servers and databases** a user may have. Enforced at
  create-time in the Orchestrator (409 when over quota) — only in hosted edition.
- **Entitlements (#297).** Beyond the counts, a plan sets:
  - **Memory**: a ceiling on the memory an account commits *across all its servers* — a total, so it
    cannot be multiplied by creating more servers. Measured in MB on the node each server runs on (a
    percentage cap is only a size once the node is known). Under a ceiling, every server needs a memory
    limit: an uncapped one could take the whole node. Creating a server or raising its limit past what
    is left is refused (409, naming the numbers). *Lowering* one is always allowed, even while the
    account is still over, so an account the plan shrank under has a way back.
  - **Backups per server**: a ceiling that works like `keepLast` — the next backup replaces the oldest
    rather than being refused, because a nightly schedule that starts failing protects nothing. A
    server's own, tighter retention still applies; the audit trail says when a backup went because of
    the plan.
  - **Storage is not modelled.** It could not be enforced: per-server disk quotas need filesystem
    support most hosts lack (#278). A number the platform cannot hold to would be a promise, not a limit.
  - `null` means no ceiling. A plan that existed before these fields keeps behaving as it did — they are
    empty until someone sets them; a fresh install seeds the default plan with 8 GB and 10 backups.
- **Who is measured.** A server counts against its **owner's** plan, whoever makes the change: an
  administrator resizing somebody's server spends that person's memory. The platform role buys no
  exemption — it is standing in the installation, not a bigger plan. Moving a server between nodes is an
  operator's decision and is not measured.
- **The charging model is stated, not implied.** Creating a server costs nothing, and neither does a
  stopped one: the charge is per hour a server *runs*. The New Deployment form and the Billing page say
  exactly that, built from the same constants the charge uses (`chargingModel` in `pricing.ts`), so the
  sentence cannot drift from the arithmetic. It used to be unstated, and "nothing happened when I
  created a server" read as a bug.
- **If the Billing Bridge is down**, nothing is enforced (and it is logged) — the same fail-open decision
  as the quota check: a billing outage must not stop people running servers.
- **Prepaid credit wallet in NexusInfra.** Each user has a **credit balance** held in NexusInfra. Usage
  each cycle draws it down. You **top up** the balance **via FinVault** — so you can fund the wallet
  without linking a card directly to NexusInfra.
- **Top-up flow.** A top-up emits `payment.request` to FinVault referencing the **user** (FinVault
  resolves the user's wallet/payment method on its side); on `payment.confirmed` the credit is added, on
  `payment.failed` the top-up is marked failed.
- **Monthly cycle + free hours.** Billing runs on a monthly cycle; each plan grants **free hours/month**
  before charging begins.
- **Suspend on empty balance.** At cycle close (or when the balance can't cover accrued usage), the
  Billing Bridge emits `billing.server.suspend {deploymentIds}`; the Orchestrator stops those servers.
  They resume after a successful top-up.

## Data model (Billing Bridge, own store)

- `billing_plans` — `price_per_hour`, `resource_factor` inputs, `free_hours_per_month`, `max_servers`,
  `max_databases`, `server_type`.
- `server_billing` — per (deployment, user): `started_at`/`stopped_at` intervals → `total_hours`,
  `total_cost`, `status`.
- `credit_wallet` — per user: `balance`, `currency`.
- `credit_ledger` — top-ups and charges (append-only) with a `reference` linking to a `payment.*` event.
- `billing_cycles` — per user per month: `period_start/end`, `total_cost`, `status` (open/paid/overdue).

## Events

| Event | Direction | Purpose |
|---|---|---|
| `payment.request` | NexusInfra → FinVault | Top up the user's credit (charge their FinVault wallet) |
| `payment.confirmed` | FinVault → NexusInfra | Top-up succeeded → add credit |
| `payment.failed` | FinVault → NexusInfra | Top-up failed → mark failed (suspend if balance can't cover usage) |
| `billing.server.suspend` | Billing Bridge → Orchestrator | Stop a user's servers when credit is exhausted |
| `invoice.generate` | NexusInfra → FinVault | Monthly invoice record |

> `billing.server.suspend` and `invoice.generate` are defined in `shared/src/events.ts` (added in #145;
> NexusInfra-only routing keys, the envelope/encryption contract unchanged).

## How it links to the app (FinVault)

- **Identity.** Long-term, the dashboard authenticates with a **FinVault-issued JWT** (shared identity,
  via the API Gateway #20), so a NexusInfra `userId` *is* the FinVault user. `payment.request` references
  that user; FinVault resolves the wallet. Until the gateway lands, the stub login stands in.
- **Money never touches NexusInfra directly.** NexusInfra only holds a **credit balance**; the actual
  charge happens in FinVault (card/wallet), decoupled over RabbitMQ with AES-GCM-encrypted payloads.
- **The panel keeps the balance current (#296).** A balance changes with nothing happening on the
  Billing page — an hourly charge, a cycle run, a top-up FinVault confirms asynchronously — so the page
  re-reads wallet, usage and ledger every 15 s, every 3 s while a top-up is pending, and at once when
  the tab is shown again. It says when the figures were read, announces a confirmed top-up, and a
  failed refresh keeps the last figures on screen **marked as out of date** rather than presenting
  them as current. Polling rather than a push: cheap, and the confirmation it waits on is seconds
  away, not milliseconds.
- **Both run standalone.** The integration is optional and event-driven; NexusInfra (either edition) works
  without FinVault, FinVault works without NexusInfra.

## Build plan (Phase 4 — the hosted edition, behind the flag)

1. **Edition flag** (#144): `NEXUS_EDITION` across services + `GET /config` → dashboard hides/shows
   billing. Community stays the default; no behaviour change unless `hosted`.
2. **shared** (#145): add `billing.server.suspend` + `invoice.generate` event types.
3. **billing-bridge service** (#146): pure pricing/quotas (`computeCharge`, `resourceFactor`) + tests;
   persistence (repository interface, in-memory + Prisma); consume `deployment.created` +
   `server.started/stopped` → `server_billing` intervals; credit wallet + ledger; top-up
   (`payment.request`) + result handling.
4. **cycle runner** (#147): monthly aggregation → charge credit → `billing.server.suspend` when short;
   `invoice.generate`.
5. **orchestrator** (#148): enforce plan quotas at create-time (hosted) + consume `billing.server.suspend`
   → stop servers.
6. **dashboard Billing page** (#149): credit balance, top-up (amount → FinVault), usage/cost breakdown,
   history — shown only in hosted edition.
