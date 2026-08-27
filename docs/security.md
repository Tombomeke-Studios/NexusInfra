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
| **admin** | The above, plus writing files, databases, backups, schedules, managing access, and editing the server's configuration (#220) |
| **owner** | The above, plus deleting the server |

### Credential checks are rate limited (#225)

The API Gateway limits per IP, and the dashboard's nginx proxies `/api` straight to the Orchestrator,
around it — so login was unlimited against bcrypt hashes, whose work factor slows an attacker by a
constant rather than by enough.

Attempts are now measured per address **and** per account. Per-IP alone is defeated by a botnet
spreading one password list; per-account alone lets one machine work through a list of accounts. Only
failures count, and a success clears them, so someone signing in normally never meets the limit. A
lockout answers exactly the same `401` as a wrong password, for the same reason unknown accounts do:
a distinct reply would confirm the account is worth attacking.

### Sessions can be ended (#227)

A JWT is stateless. Before this, a token remained valid until it expired regardless of what happened
to the account behind it — changing a password did not sign other devices out, and "sign out" was a
client-side gesture that left the token working for anyone holding a copy.

Tokens now name a session row, which `requireAuth` verifies still exists. That costs one indexed read
per authenticated request and buys the ability to answer truthfully: sign out ends *this* session,
changing a password ends every *other* one, and a person can see where they are signed in and end any
of it. A token naming no session is refused outright, because an unrevocable token is what this
replaced.

### Importing a host directory (#268)

Mounting an existing directory into a server is the most dangerous capability in the panel, because
the person who owns that server has a root shell inside the container. `/`, `/var/run/docker.sock`
or a home directory mounted in is the whole machine. It is therefore fenced in four ways:

- **Platform administrators only.** It never follows from a per-server role, however high.
- **Off by default.** A node imports nothing unless `IMPORT_ROOT` is set on that node.
- **The node decides.** Only the agent can see its own filesystem, so the orchestrator asks it; the
  agent checks again at container start rather than trusting an event that crossed a broker.
- **Resolved, then checked.** Containment is tested on the real path after symlink resolution, and by
  path segment rather than string prefix — `/srv/import-evil` is not inside `/srv/import`, and
  `/srv/import/escape -> /` passes any check performed before resolution.

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

### Invitations (#176)

A server can be shared with someone who has no account yet. That invitation is addressed to an email
and **grants nothing** until it is bound to a real account — it is claimed automatically when that
person registers or signs in with the address. Two consequences worth being explicit about:

- Holding an invited address is not the same as holding the account. Access is checked against the
  bound account, so an unclaimed invitation cannot be used by whoever happens to control the mailbox
  at some later point without also completing a sign-up.
- Changing someone's role never un-binds an accepted share, and revoking one takes effect on the very
  next request.

### Teams (#177)

A team shares every server attached to it with everyone in it. The rules that keep this from becoming
a way to lose control of a server:

- **A server is owned by a person, never by a team.** It is only *shared* to one, so ownership is
  never ambiguous and deleting a team **detaches** its servers rather than deleting them.
- **Only the team's owner changes membership**; anyone may remove themselves, which is how you leave.
- **Membership requires an existing account.** Unlike a per-server invitation, joining a team grants
  access to every server it holds, present and future — that should not sit waiting on an address
  nobody has claimed.
- **A server can only be attached to a team the caller belongs to**, so a server cannot be pushed onto
  strangers, and attaching it needs owner-level permission rather than day-to-day management rights.
- **A team cannot confer ownership**, exactly as a direct share cannot. Where both a direct share and
  a team membership apply, the stronger of the two wins.
- A team the caller doesn't belong to reads as **404**, for the same reason a server does — otherwise
  team identifiers become a directory of who works with whom.

Since **#224** the team routes are authorized the same way the server routes are, rather than each
handler checking ownership for itself: a guard on the whole `/teams/:id` subtree resolves the caller's
standing once, and each route declares the permission it needs. The reason is the one that motivated
#175 — authorization repeated in sixty places is authorization that eventually gets omitted in one of
them, and nothing about the omission looks wrong at the call site.

A team has **no role ladder of its own**: you either own it or you are in it. The role stored on a
membership is a *server* role — what that member gets on the servers the team holds — and confers
nothing over the team itself. Two consequences fall out of the same distinction:

- **Leaving is not managing.** Removing someone else needs the owner; removing yourself never does.
- **A platform administrator gets nothing on a team**, unlike on a server. Administering the
  installation means reaching the hosts, and there is no operation on a team that an admin cannot
  already perform on the servers it holds. A team is a private grouping of people, not infrastructure.

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

- The subuser API manages **who may access a server** (by email) and their role, and **enforces it**
  since #175: every `/deployments/:id/*` route resolves the caller's role on that specific server and
  answers `404` when they have none. (This paragraph previously said enforcement was still to come; it
  was left behind by #175 and is corrected here.)

## Transport security (#245)

**The stack speaks plain HTTP and terminates no TLS itself.** The login carrying a password, every
JWT after it, and the WebSocket that opens a root shell in a container all travel in the clear.

That is a deliberate division of labour rather than an oversight — certificate renewal, HSTS and
cipher selection belong to a reverse proxy, and every host already has one it prefers — but it makes
one rule absolute: **do not expose this stack without a proxy in front of it.** On a LAN you control
the risk is yours to take; across any network you do not, an observer has the session.
[deployment.md](deployment.md#putting-it-behind-tls-245) has working Caddy and nginx configurations,
which ports to publish and which never to, and the `TRUST_PROXY` setting that keeps per-IP rate
limiting meaningful once every request arrives from the proxy's address.

## Known gaps (foundation phase)

- No auth on Control Room HTTP endpoints yet (localhost/dev only) — gated by the gateway later.
- No TLS on AMQP; assumed same-host/private-network broker in dev.
