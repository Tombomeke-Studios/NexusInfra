# The installer

`install.sh` and `install.ps1` ship inside the release archive. They exist to remove the gap between
downloading NexusInfra and having it running — choosing an edition, generating three secrets by hand,
and editing a configuration file before anything starts.

Using it is entirely optional. The [all-in-one image](images.md#the-all-in-one-image) needs no script
at all, and [images.md](images.md) documents every image well enough to write your own Compose file.
Declining to run a shell script you downloaded is a reasonable position, and nothing here depends on
you changing it.

---

## What it does

```bash
./install.sh                                              # Linux, macOS
powershell -ExecutionPolicy Bypass -File install.ps1      # Windows
```

In order:

1. **Checks Docker.** Refuses early, with a readable message, if Docker or Compose v2 is missing —
   rather than failing halfway through with a stack trace.
2. **Asks which edition** you want, unless you passed one as an argument. The choice is explained at
   the prompt, not assumed.
3. **Collects the administrator email and password.** The password is read without echoing. Leave it
   blank and one is generated and shown to you once.
4. **Generates the secrets.** `JWT_SECRET` and `INTERNAL_API_TOKEN` become 32 random bytes each from
   `openssl rand` (or the platform's cryptographic RNG on Windows). These are never defaulted: the
   first mints login tokens for any account, the second reaches an API that can start containers, so
   a shipped default would be a shipped backdoor.
5. **Asks for `FINVAULT_MESSAGE_KEY`** in the hosted edition, warning that it must match FinVault's
   exactly, and lets you fill it in later.
6. **Writes `.env`** in the chosen edition's directory, `chmod 600`.
7. **Offers to start the stack**, and prints the panel address and the account to sign in with.

## Running it more than once

Safe. An existing `.env` is never overwritten without asking; choose to replace it and the previous
one is kept as `.env.backup.<timestamp>` rather than deleted.

To skip the questions entirely, pass the edition and pre-set the values:

```bash
ADMIN_EMAIL=me@example.com ADMIN_PASSWORD='…' ./install.sh community
```

## What it does not do

- **No TLS.** It does not obtain or configure certificates. Put a reverse proxy in front before this
  is reachable from anywhere but your own machine.
- **No firewall or hardening.** The compose bundles keep the node agent's port and the broker off the
  host, but the panel and gateway are published.
- **No upgrades.** It installs; upgrading is `docker compose pull && docker compose up -d`, with the
  version pinned in `.env`.
- **Nothing remote.** It contacts no network service of ours, has no telemetry, and pulls only the
  images named in the compose file.

## Reading it before running it

It is a plain shell script, about 130 lines, in the archive you already downloaded. Everything it does
is listed above and visible in the source. If you would rather not, use the all-in-one image or write
your own Compose file — both are supported paths, not fallbacks.
