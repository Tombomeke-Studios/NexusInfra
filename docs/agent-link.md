# The agent link — nodes behind NAT (#416)

A node has two connections, in opposite directions:

| Direction | What | How |
|---|---|---|
| node → control plane | heartbeats, server events | the agent connects to the broker: works from anywhere the broker port is reachable |
| control plane → node | files, the console, the terminal, logs and stats, backups, databases, disk use | the orchestrator **calls the agent** |

The second direction needs an address the orchestrator can call. A node behind NAT — a laptop on a
school network, a home server, a 4G or CGNAT line — has none. Its heartbeats arrive, so it reads
*healthy*, but nothing can be done to it.

The agent link turns that direction round: the agent opens **one WebSocket to the control plane**, and
the orchestrator's calls to that agent come back over it. The node needs no inbound port.

The design is shared with [NexusFleet](https://github.com/Tombomeke-Studios/NexusFleet/blob/dev/docs/agent-link.md),
which provisions such nodes; the names and numbers below are that contract.

## Two kinds of node

Each node record carries a `connection`:

| `connection` | The control plane reaches the agent… | The node needs |
|---|---|---|
| `direct` (default) | by calling it on its `agentUrl`, as before | an address the orchestrator can reach, and port 9100 open to it |
| `outbound` | over the agent link the agent opened | to reach the control plane's public address (443 behind TLS) |

Direct nodes behave exactly as they did before the link existed.

## Setting one up

1. Register the node as outbound: `POST /nodes` with `{ "id": "laptop-1", "connection": "outbound" }`.
   No `agentUrl` — one sent anyway is ignored.
2. Mint its link token: `POST /nodes/laptop-1/link-token` → `{ "token": "nxl_…" }`. It is shown once;
   only its digest is stored.
3. Start the agent with `NODE_ID=laptop-1`, `AGENT_LINK_URL=wss://<panel host>/agent-link`,
   `AGENT_LINK_TOKEN=<the token>`, and **without** publishing port 9100. See
   [images.md — Adding a machine](images.md#adding-a-machine).
4. `GET /nodes` shows `"linked": true` once the link is up, and `GET /nodes/laptop-1/disk` answers —
   that answer is the proof the node can be controlled.

Calling `link-token` again **rotates** the token: the old one stops working and the node's current link
is closed, so the agent has to come back with the new one.

The broker still needs its own port (5672). Heartbeats and server commands keep using it; only the
orchestrator → agent direction moves onto the link.

## How it works

### The connection

- The agent dials `AGENT_LINK_URL` — normally the gateway's `/agent-link` route, so the same public name
  and port as the panel. Only `wss://` is accepted, unless the host is loopback or
  `AGENT_LINK_ALLOW_INSECURE=true` (labs). A link URL that is not allowed, or one without a token, stops
  the agent at start rather than leaving a node that looks healthy and cannot be controlled.
- The handshake carries `x-nexus-node-id: <NODE_ID>` and `authorization: Bearer <AGENT_LINK_TOKEN>`. The
  token travels in a header, never in the URL.
- The gateway passes `/agent-link` through as a **public** route: no user token, since the orchestrator
  checks the link token itself. The gateway's rate limit by address still applies.
- The orchestrator accepts the upgrade only when the token matches the digest stored **for that node id**
  (constant-time). Anything else is a bare `401`, whatever the reason. One link per node: a new link
  replaces the old one.
- The agent reconnects with a doubling delay from 1 s up to 30 s. Both sides ping every 15 s and drop a
  link that said nothing for 45 s — a NAT that silently forgot the mapping is noticed on both ends.
- With a link configured, the agent's heartbeat says `connection: "outbound"` and advertises no
  `agentUrl`.

### Byte streams, not API calls

The link carries byte streams, so HTTP, server-sent events (live logs and stats) and the terminal's own
WebSocket all pass through unchanged. Every frame is one binary WebSocket message:

```
[type: u8][streamId: u32 big-endian][payload]
type 1 OPEN   orchestrator → agent, empty payload
type 2 DATA   both ways, raw bytes
type 3 END    both ways: the sender will write no more
type 4 RESET  both ways: the stream failed; payload = a short UTF-8 reason
```

- The orchestrator opens a stream per connection. The agent answers an OPEN by connecting to **its own
  HTTP server on `127.0.0.1:<PORT>`** and piping both ways; it opens nothing else. An OPEN sent to the
  orchestrator is refused.
- On the orchestrator a stream is a Node.js `Duplex`. An outbound node's agent URL is a name nothing
  resolves (`http://<hex node id>.agent-link.invalid`), so every place that builds an agent request from
  `agentUrlFor(nodeId)` stays as it is. `agentFetch` recognises that name and sends the request through an
  undici `Agent` whose `connect` opens a link stream; the terminal proxy gives `ws` a `createConnection`
  that does the same. The internal token header is still sent, so the agent's own checks are unchanged.
- Backpressure: a sender stops reading its source while the WebSocket has more than 1 MiB waiting.
- A link that drops fails every stream on it; requests in flight fail as if the agent had gone away.

### When there is no link

A call to an outbound node while it has no link answers `502` with `{ "error": "node has no agent link" }`
— the same status an unreachable direct agent gets. That includes `GET /nodes/:id/disk`, so that endpoint
keeps meaning "this node can be controlled". A terminal opened then is closed straight away.

`GET /config` lists `features: ["agent-link"]`, so a client can tell whether a control plane supports any
of this before relying on it.

## Why a token per node

The shared `INTERNAL_API_TOKEN` could not be the link credential. With it any node could open a link as
another node and be sent that node's file and shell traffic. A link token opens one node's link and no
other: the orchestrator binds the link to the node id the token was minted for. See
[security.md](security.md#agent-links-416).

## Code

| Where | What |
|---|---|
| `shared/src/agentLink.ts` | Framing, the stream multiplexer (`LinkSession`, `LinkStream`), the keep-alive |
| `services/node-agent/src/link.ts` | The agent's half: env and URL rules, dialling, reconnecting, piping streams to loopback |
| `services/orchestrator/src/agentLink.ts` | The orchestrator's half: link URLs, tokens, the handshake check, the registry, `linkFetch` |
