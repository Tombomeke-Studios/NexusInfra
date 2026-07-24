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

## Authentication (planned)

- Dashboard/API auth uses **FinVault-issued JWTs** validated at the NexusInfra gateway (#20) —
  one identity across the ecosystem.
- WebSocket connections authenticate via JWT in the query string, mirroring FinVault's gateway.

## Container file management (#108)

- The Node Agent's file API operates **inside** the target container. Every path is normalised to a
  traversal-safe absolute form first, so `..` segments collapse and can never climb above the
  container root (they also never reach the host — operations run in the container's namespace).
- File operations are issued as **argv arrays**, never a shell string, so a crafted path can't inject
  a command; writes go through Docker's archive API rather than a shell redirect.
- The endpoints are **agent-internal** — reached only via the Orchestrator's proxy on the private
  network, which gates them on a running deployment. User-facing authorisation rides on the same JWT
  as the rest of the API; per-server subuser scoping is a later slice (#112).

## Managed databases (#109)

- A database is provisioned as its **own engine container** with credentials the Orchestrator
  generates; the agent's database endpoint is internal (proxy-only) and engine-whitelisted.
- **Known gap:** the generated database password is currently stored in plaintext in the Orchestrator's
  database. It should be encrypted at rest (the `FINVAULT_MESSAGE_KEY` primitives already exist) or
  vaulted before production — tracked with the auth/secrets hardening (#21).

## Backups (#110)

- A backup is a tar the agent writes under an **opaque, filesystem-safe ref** (validated so a crafted
  ref can't traverse out of the backup directory); the agent's backup endpoint is internal (proxy-only).
- Tars live on the **node that made them** (single-node MVP); the Orchestrator stores only metadata, not
  the blob. Multi-node placement + off-node backup storage is a later (production) concern.

## Known gaps (foundation phase)

- No auth on Control Room HTTP endpoints yet (localhost/dev only) — gated by the gateway later.
- No TLS on AMQP; assumed same-host/private-network broker in dev.
