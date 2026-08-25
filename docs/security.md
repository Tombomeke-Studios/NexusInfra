# Security

Updated with every change touching auth, secrets, message encryption, or other security concerns.
Cross-project security design: [`../../CONCEPTS/integration/security.md`](../../CONCEPTS/integration/security.md).

---

## Event payload encryption

- Payloads on the shared bus are **AES-256-GCM** encrypted when `FINVAULT_MESSAGE_KEY` is set.
  Key derivation: scrypt over the message key with a fixed public salt (`finvault-events-v1`) —
  identical to FinVault so ciphertext is interoperable. Entropy comes from the key, not the salt.
- Ciphertext layout `iv(12) | tag(16) | ct`, base64. GCM auth tag rejects tampering.
- The event `type` is deliberately plaintext (needed for topic routing); never put sensitive data
  in routing keys or event types.
- An empty message key sends plaintext payloads — acceptable for local dev only.

## Secrets

- All secrets come from the environment (`.env`, never committed). `.env.example` documents every
  variable without values.
- `FINVAULT_MESSAGE_KEY` is shared with FinVault — treat it with the same care as FinVault does;
  rotating it requires rotating both platforms together.
- RabbitMQ dev credentials (`guest/guest`) must be replaced in any non-local deployment.

## Authentication (#174)

The panel owns its own identity. Each person has an account; signing in returns a short-lived
JWT that carries the account and its panel-wide role, and every request below the public routes
requires one.

- **Credentials** are stored only as bcrypt digests, never reversibly. An account may hold a
  deliberately unusable digest — used for accounts that exist to own resources but cannot sign in,
  such as the owner reconstructed for servers created before accounts existed. No password can ever
  verify against it.
- **No anonymous fallback.** Earlier builds let an unauthenticated request act as a shared default
  user; that now means acting as the owner of somebody's servers, so a missing or invalid token is
  rejected outright.
- **Login does not reveal which accounts exist** — an unknown address and a wrong password return
  the same response, so the form cannot be used to enumerate users.
- **Self-registration follows the edition.** The hosted edition is a hosting provider, so customers
  sign themselves up. The community edition is somebody's own machine, where an open sign-up form on
  a panel that controls Docker would be a liability: there an administrator creates accounts, and
  the registration route is refused outright rather than merely hidden in the UI.
- **Registration cannot grant privilege.** A role supplied by the registrant is ignored; elevated
  roles are only ever assigned by an existing administrator.
- **Bootstrap.** A fresh install seeds one administrator from the environment. Leaving the built-in
  default password in place logs a warning on every start — set `ADMIN_PASSWORD` before exposing a
  panel to a network.
- WebSocket connections authenticate via a JWT in the query string (browsers cannot set headers on
  the handshake), mirroring FinVault's gateway.

A valid token establishes only *who* the caller is. What they may do is a separate concern — see
below.

**Planned:** the same JWT issued by FinVault and validated at the gateway (#20/#17), giving one
identity across the ecosystem. The provider seam in the Orchestrator's auth module exists so this
becomes a swap rather than a rewrite.

## Authorization — who may do what to a server (#175)

Authentication and authorization are kept strictly apart. A token says who is calling; it never says
what they may do. Access to a server is resolved **per request**, so revoking a share takes effect
immediately rather than whenever the holder's token happens to expire.

**Two kinds of role, deliberately not interchangeable:**

- **Platform role** — panel-wide standing. Administrators manage the node fleet and accounts, and are
  treated as owners of every server: they already control the hosts those containers run on, so
  pretending otherwise would be theatre rather than security.
- **Server role** — what one person may do to one server, from ownership, a direct share, or (later)
  a team. Where several grants apply, the strongest wins.

| Role | May |
|---|---|
| **viewer** | See the server, its logs and its resource usage |
| **operator** | The above, plus start / stop / restart, the console, and reading files |
| **admin** | The above, plus writing files, databases, backups, schedules and managing access |
| **owner** | The above, plus deleting the server |

Design decisions worth stating explicitly:

- **No access answers 404, not 403.** A 403 would confirm that a server exists, letting anyone walk
  identifiers to discover what other people run. The distinction is invisible to a legitimate user,
  who sees 404 either way. Once the caller may see a server at all, a 403 on a specific action is
  safe and used.
- **A share can never confer ownership.** Only the roles below owner are grantable, so a server
  admin cannot hand out — or grant themselves — the right to destroy the server and its backups.
- **The guard covers a whole route subtree**, so a route added later is protected by default; it only
  has to declare which permission it needs. Forgetting to declare one fails closed.
- **Sensitive reads are treated as management, not viewing** — database credentials and the list of
  who else has access are not visible to an operator.
- **The interactive terminal is authorized, not merely authenticated.** It opens a root shell inside
  the container, so it requires console access on that specific server.
- **Billing follows the owner.** Usage accrues to whoever owns the server, never to the person who
  pressed Start.

## Service-to-service auth (#169)

The Node Agent's HTTP/WS surface drives Docker directly — `POST /exec/:id`, file writes, and a
`WS /terminal/:id` root shell — with the Docker socket mounted. It was previously **unauthenticated**,
described only as "internal, proxy-only". Nothing enforced that, and compose published its port to the
host, so anyone able to reach it had unauthenticated command execution in every container, bypassing the
Orchestrator's JWT entirely.

Now:

- Every internal route **and** the WebSocket upgrade require a shared secret (`x-internal-token`).
  `GET /health` stays open so probes work.
- Tokens are compared **constant-time** (SHA-256 then `timingSafeEqual`), so neither the token's
  contents nor its length leak through timing, and a length mismatch can't throw.
- The secret is `INTERNAL_API_TOKEN`, shared by the Orchestrator and Agent. It falls back to a
  well-known dev default (matching the existing `JWT_SECRET` convention) so local dev works with no
  setup; the Agent **logs a warning on startup when the default is in use**. Override it with a strong
  random value in any real deployment.
- "Internal" is now an enforced boundary rather than a convention, but it is still **defence in depth,
  not isolation**: don't publish the agent's port in production (the compose mapping is a dev
  convenience) and keep the agent on a private network.

**Remaining gap:** the token is a static shared secret with no rotation, and AMQP/HTTP hops are still
plaintext on the private network. mTLS and rotation belong with the production hardening (#21).

## Container file management (#108)

- The Node Agent's file API operates **inside** the target container. Every path is normalised to a
  traversal-safe absolute form first, so `..` segments collapse and can never climb above the
  container root (they also never reach the host — operations run in the container's namespace).
- File operations are issued as **argv arrays**, never a shell string, so a crafted path can't inject
  a command; writes go through Docker's archive API rather than a shell redirect.
- The endpoints are **agent-internal** — token-guarded (#169) and reached via the Orchestrator's proxy,
  which gates them on a running deployment. User-facing authorisation rides on the same JWT as the rest
  of the API; per-server subuser scoping is a later slice (#112).

## Managed databases (#109)

- A database is provisioned as its **own engine container** with credentials the Orchestrator
  generates; the agent’s database endpoint is internal (token-guarded, #169) and engine-whitelisted.
- **Known gap:** the generated database password is currently stored in plaintext in the Orchestrator's
  database. It should be encrypted at rest (the `FINVAULT_MESSAGE_KEY` primitives already exist) or
  vaulted before production — tracked with the auth/secrets hardening (#21).

## Backups (#110)

- A backup is a tar the agent writes under an **opaque, filesystem-safe ref** (validated so a crafted
  ref can't traverse out of the backup directory); the agent's backup endpoint is internal
  (token-guarded, #169).
- Tars live on the **node that made them** (single-node MVP); the Orchestrator stores only metadata, not
  the blob. Multi-node placement + off-node backup storage is a later (production) concern.

## Subusers (#112)

- The subuser API manages **who may access a server** (by email) and their role (`admin`/`viewer`), but
  **does not yet enforce it** — the panel still authenticates as the single stub user. Enforcement (mapping
  a logged-in identity to its allowed servers/roles) lands with real multi-user login via the FinVault-JWT
  gateway (#20). Until then this is intentionally a management/record layer, not an access boundary.

## Known gaps (foundation phase)

- No auth on Control Room HTTP endpoints yet (localhost/dev only) — gated by the gateway later.
- No TLS on AMQP; assumed same-host/private-network broker in dev.
