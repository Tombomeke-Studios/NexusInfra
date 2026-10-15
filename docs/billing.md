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
- **A catalogue of plans (#369).** The provider defines plans in the panel — price per hour, free hours,
  ceilings — and a customer picks one on the Billing page. There used to be a single plan, seeded at
  first start, that every account got and nobody could change.
  - **Switching is refused when the account does not fit** the new plan (more servers, databases or
    memory than it allows), with what has to go first. The page shows that beside each plan rather than
    offering a button that fails.
  - **What ran before a switch is charged at the old rate.** Running servers are re-opened under the new
    plan at the moment of the switch, and each stretch of runtime is charged at the rate of the plan it
    ran under. Otherwise the cheapest strategy would be the big plan all month and the small one on
    the 30th.
  - **Editing a plan's price reprices the month in progress** for everyone on it: the charge is computed
    when the month closes. Change prices at a month boundary, or add a new plan and retire the old one.
  - **Retiring** a plan keeps the accounts it has and stops anyone new choosing it. The default plan
    cannot be retired — every new account starts on it.
- **The provider's view (#369).** Platform administrators get a page listing every account with its
  plan, balance, what is left to spend, this cycle's usage and running servers, and can move an account
  to another plan or add and remove credit by hand. A manual adjustment goes on the ledger like any
  other movement, with who did it and why — the customer sees it in their payment history.
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
- **Top-up flow (#351).** A top-up emits `payment.request` to FinVault carrying the customer's **email
  address**. FinVault turns it into a payment request in that person's FinVault account — under
  Invoices → Payment Requests, in the web and mobile apps — payable to the hosting provider's merchant
  account. Nothing is charged until the customer presses Pay there. On `payment.confirmed` the credit is
  added; on `payment.failed` (declined, or refused by FinVault) the top-up is marked failed with
  FinVault's reason, which the Billing page shows.
  - **Who pays is the signed-in account, by its own address.** The Orchestrator fills the email in from
    the session; one sent by the browser is ignored, because the address decides whose FinVault inbox
    receives a payment request. A NexusInfra user id means nothing to FinVault until the two share an
    identity (#17), and the email is what both already have.
  - **The address has to be confirmed first (#367).** A self-registered account is mailed a single-use
    link, and a top-up is refused (`403`) until it has been opened — otherwise anyone could register with
    another person's address and send payment requests to their FinVault account. The Billing page says
    so, holds the button, and can send the link again.
    - Only where the installation **can** confirm: it needs `SMTP_URL` and `PANEL_URL`, like the password
      reset. Without them nothing is gated — a rule nobody can satisfy would lock every customer out of
      paying — and the caps below are the only protection: three top-ups waiting per NexusInfra account,
      five open requests per recipient in FinVault. **Set both before taking real customers.**
    - Accounts an administrator creates, the first administrator, and anyone who completes a mailed
      password reset count as confirmed. Accounts from before this start unconfirmed.
  - **Not sent is not pending.** If the broker does not take the request, the top-up fails immediately
    and says so, rather than waiting out the timeout for an answer that cannot come.
  - **Once, and for the amount asked.** The status change is a single conditional update, so a
    confirmation delivered twice credits once (#298 — before, two concurrent deliveries both
    credited). A confirmation for a different amount than was requested credits nothing and is logged
    for someone to check by hand.
  - **Silence ends.** A top-up with no answer after `TOPUP_TIMEOUT_MS` (default 30 min) is shown as
    **Not confirmed**, with an explanation on the Billing page — a mismatched `FINVAULT_MESSAGE_KEY`
    used to leave it pending forever. It is not final: a confirmation that arrives later means the
    money moved, and is still credited.
- **Monthly cycle + free hours.** Billing runs on a monthly cycle; each plan grants **free hours/month**
  before charging begins.
- **Prepaid is enforced while servers run (#365).** An account's *standing* is its balance less what it
  has used and not yet been charged for — this month so far, plus a closed month the cycle has not
  billed yet. It used to be looked at once a month, so an account with no credit ran servers until the
  month closed, and could start a suspended server again straight away.
  - **Starting needs credit.** Creating or starting a server is refused with `402` when nothing is left,
    with a message that points at the Billing page. Measured against the server's **owner**, whoever
    presses Start. Stopping, deleting and reading are never blocked.
  - **Running servers are stopped when the credit runs out.** Every five minutes (`SETTLE_INTERVAL_MS`)
    the bridge compares each running account's usage with its balance and emits
    `billing.server.suspend {deploymentIds}` for those that have none left; the Orchestrator stops the
    servers and notifies the people on them. Nothing is *charged* by this — the monthly cycle still does
    that — so the ledger keeps one charge per month.
  - **A suspended server says so (#380).** The Orchestrator records the suspension with the server —
    when and why — rather than only in its audit trail, so the Servers list and the server's page show
    it as *suspended* and say whose credit ran out, until it is started again. Starting it clears the
    mark, and starting still needs credit (`402` otherwise). It used to look like any other stopped
    server, and the customer learned why only by pressing Start.
  - **Free hours count.** An account that owes nothing and still has free hours this month may run, which
    is how a plan with a free allowance lets a new customer start before paying. A provider who wants
    payment first sets the plan's free hours to zero.
  - **Warned before, not only told after (#379).** The standing says how many hours what is left lasts
    at the rate the running servers spend it — the free hours first, which every running server spends
    at once, then the credit. Nothing running means no estimate, not an infinite one. The Billing page
    shows it under *Left to spend*. When it drops under `LOW_CREDIT_HOURS` (default 24) the bridge
    publishes `billing.credit.low` once, and the account hears it on the channels it chose for
    `credit.low` (#236) — an event the community edition does not offer. The bridge remembers that it
    warned, with the wallet, so a restart does not warn again; it forgets once the credit lasts the
    threshold again, so the next dip warns. Stopping the servers changes nothing either way. An
    account that has already run out hears about the suspension instead.
    It is an estimate: it assumes the servers keep running as they are, and does not count next
    month's free hours.
  - **Servers do not restart on their own after a top-up.** The customer starts them; a stopped game
    server coming back unasked, at an hour nobody chose, is its own kind of surprise.
  - **If the bridge cannot be asked, nothing is blocked** (and it is logged), as with quotas.
- **This cycle's usage is this cycle's (#366).** The Billing page's hours and cost are computed for the
  month in progress with the same function the cycle runner charges with. They used to sum every
  interval the account ever had, so the figure only grew and stopped matching the bill.

## Data model (Billing Bridge, own store)

- `billing_plans` — `price_per_hour`, `resource_factor` inputs, `free_hours_per_month`, `max_servers`,
  `max_databases`, `server_type`.
- `billing_deployment` — per deployment: its owner and its size. Written when a server is created or
  resized, so what a server costs survives a restart of the bridge (#364) — it used to be remembered in
  memory, and every server started after a restart ran unbilled.
- `server_billing` — per (deployment, user): `started_at`/`stopped_at` intervals → `total_hours`,
  `total_cost`, `status`.
- `credit_wallet` — per user: `balance`, `currency`.
- `credit_ledger` — top-ups and charges (append-only) with a `reference` linking to a `payment.*` event.
- `billing_cycles` — per user per month: `period_start/end`, `total_cost`, `status` (open/paid/overdue).

## Events

| Event | Direction | Purpose |
|---|---|---|
| `payment.request` | NexusInfra → FinVault | Top up the user's credit (charge their FinVault wallet) |
| `payment.confirmed` | FinVault → NexusInfra | Top-up succeeded → add credit (accepted on `bank.payment.confirmed` and on `events.payment.confirmed`, the key FinVault's gateway actually publishes on) |
| `payment.failed` | FinVault → NexusInfra | Top-up failed → mark failed (suspend if balance can't cover usage) |
| `billing.server.suspend` | Billing Bridge → Orchestrator | Stop a user's servers when credit is exhausted |
| `billing.credit.low` | Billing Bridge → Orchestrator | The account's credit lasts less than `LOW_CREDIT_HOURS` — notify it (#379) |
| `invoice.generate` | NexusInfra → FinVault | Monthly statement: what the account used, with `customerEmail` so FinVault can file it under the customer (#375) |

> `billing.server.suspend` and `invoice.generate` are defined in `shared/src/events.ts` (added in #145;
> NexusInfra-only routing keys, the envelope/encryption contract unchanged).

## What has been verified against FinVault (#298)

Run against a checkout of FinVault's `main` on one RabbitMQ, with the hosted stack from source:

| | |
|---|---|
| Payload encryption | ✅ Both directions, with FinVault's own `encryptPayload`/`decryptPayload`; a FinVault-made ciphertext is a test fixture |
| FinVault → NexusInfra confirmation | ✅ `payment.confirmed` sent through FinVault's `publishEvent` and gateway moved a real balance |
| Mismatched message key | ✅ Names its cause in the log, dead-letters (the Control Room reports it), and the top-up turns **Not confirmed** |
| Late confirmation | ✅ Credited after expiry |
| Monthly cycle | ✅ Charge → short balance → `billing.server.suspend` → the server's container actually stopped |
| NexusInfra → FinVault request | See "The whole top-up, live" below |

### The whole top-up, live (#351)

Run on 2026-10-14 with both platforms from source — FinVault's gateway and its account, wallet and
invoice services; NexusInfra's Orchestrator and Billing Bridge in the hosted edition — on one RabbitMQ,
with `FINVAULT_MESSAGE_KEY` set, so every payload was encrypted:

| | |
|---|---|
| Request reaches FinVault | ✅ A top-up asked for in the panel became a payment request in the FinVault account with the same email, payable to the merchant account |
| The payer is the signed-in account | ✅ An address put in the request body was ignored |
| Paid in FinVault | ✅ The money left the customer's FinVault account and the NexusInfra balance rose by the same amount, seconds later |
| Pay pressed twice at once | ✅ One transfer, one credit; the second call was told the request is no longer pending |
| Declined in FinVault | ✅ The top-up turned **Failed** with FinVault's reason; the balance did not move |

Not exercised live: the FinVault apps' Pay and Decline buttons themselves (the run called the same
endpoints they call), and a confirmation that fails to publish and is retried a minute later (covered
by FinVault's unit tests only).

### The monthly statement (#375)

When a month closes and an account was charged, the bridge publishes `invoice.generate`. FinVault
records it for the account with that email address, where the customer finds it under **Invoices →
Receipts** with a PDF, titled *Server hosting — usage for September 2026, paid from your prepaid
credit*. It sits beside the top-ups that left their FinVault account, so they can see what that money
was spent on.

- **It is a statement, not a charge.** No money moves in FinVault: it moved when the top-up was paid.
- **Whose it is** is the address the account last topped up with — kept with the wallet, because the
  bridge otherwise knows a customer only by id. An account that never topped up has none; its
  statement goes out without an address and FinVault has nobody to show it to.
- Nothing was listening for this event before; it had been published since #147 to nobody.

Run live on 2026-10-14, both platforms from source on one broker with encrypted payloads: a customer
topped up €15 through FinVault, a month was closed with 300 hours of usage on the default plan (100 free,
€4.00 charged), the NexusInfra balance went to €11.00, and the statement appeared in that customer's
FinVault receipts — `HOST-2026-09-…`, €4.00, payable to the merchant account — with its PDF.

## How it links to the app (FinVault)

- **Identity.** The two platforms have separate accounts. What links a NexusInfra customer to a FinVault
  one is the **email address** on both (#351). Long-term the dashboard could authenticate with a
  FinVault-issued JWT (#17), so a NexusInfra `userId` *is* the FinVault user.
- **What FinVault needs.** `NEXUSINFRA_MERCHANT_EMAIL` set to the FinVault account that receives the
  money, the same broker, and the same `FINVAULT_MESSAGE_KEY`. Without the merchant account FinVault
  ignores top-up requests and they end as *Not confirmed*.
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
