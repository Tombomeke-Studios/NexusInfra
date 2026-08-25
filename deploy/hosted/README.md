# NexusInfra — Hosted edition

The multi-tenant instance: customers sign themselves up, usage is metered against the CPU/RAM a
server is given, and it is charged to a prepaid credit wallet topped up through
[FinVault](https://github.com/Tombomeke-Studios/FinVault).

## Run it

```bash
cp .env.example .env      # every value under "Required" must be set
docker compose up -d
```

## How it differs from the community edition

Same images, same code — one runtime flag. What the flag turns on:

| | Community | **Hosted** |
|---|---|---|
| Sign-up | an administrator creates accounts | **customers register themselves** |
| Billing Bridge | not run | **runs** |
| Billing page in the panel | hidden | **shown** |
| Plan quotas on servers and databases | none | **enforced at create time** |
| Credit wallet, top-ups, monthly cycle, suspend on empty balance | off | **on** |

Everything else — nodes, deployments, sharing, teams — behaves identically.

## Sharing a broker with FinVault

The integration is event-driven and optional, but it only works if both platforms are on the same
broker with the same message key:

1. Remove the `rabbitmq` service from `docker-compose.yml` and attach these services to FinVault's
   network instead.
2. Point `RABBITMQ_URL` at FinVault's broker.
3. Set `FINVAULT_MESSAGE_KEY` to **exactly** FinVault's value. That key derives the payload
   encryption; if the values differ the two platforms cannot read each other's events, and top-ups
   will silently never confirm.

Both stacks declare the same exchanges idempotently, so start order does not matter.

## Before this is public

This bundle is a starting point, not a hardened production deployment. At minimum, put TLS in front
of the panel and the gateway, replace the default broker credentials, and read
[docs/security.md](https://github.com/Tombomeke-Studios/NexusInfra/blob/main/docs/security.md) — the
known gaps are listed there rather than left implicit.

## Billing model

Pricing, quotas, the wallet and the monthly cycle are described in
[docs/billing.md](https://github.com/Tombomeke-Studios/NexusInfra/blob/main/docs/billing.md).
Usage always accrues to the account that **owns** a server, never to someone it was shared with.
