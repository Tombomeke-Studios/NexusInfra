# API

HTTP endpoints and event contracts. Updated with every endpoint or request/response change.

---

## Control Room (`:9000`)

### `GET /health`

Liveness probe.

```json
{ "service": "control-room", "status": "healthy", "uptimeSec": 123 }
```

### `GET /status`

Live monitoring snapshot of every heartbeat source seen on the bus.

```json
{
  "monitored": [
    { "source": "control-room", "status": "healthy", "lastSeenMsAgo": 412 }
  ],
  "thresholds": { "degradedMs": 3000, "offlineMs": 10000 }
}
```

`status` ∈ `healthy | degraded | offline` derived from last-seen age.

---

## Event contract (bus API)

The full event union is defined in `shared/src/events.ts` — that file is the contract's source of
truth. Summary:

| Event type | Direction | Notes |
|---|---|---|
| `heartbeat.service` / `heartbeat.node` | any → control-room | 1s pulse; node variant carries a resources block |
| `server.start` / `server.stopped` / `server.started` / `server.crashed` | orchestrator ↔ node-agent | container lifecycle |
| `deployment.created` / `deployment.failed` | orchestrator → bus | deployment audit events |
| `payment.request` | billing-bridge → FinVault | payload shape matches FinVault's `payment.request` exactly |
| `payment.confirmed` / `payment.failed` | FinVault → billing-bridge | consumed to keep/suspend servers |

Envelopes and encryption: see [architecture.md](architecture.md#event-bus). Payload shapes for the
`payment.*` trio must never drift from FinVault's `shared/src/events.ts`.
