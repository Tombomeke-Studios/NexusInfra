# Install NexusInfra

You have the release archive. Everything needed is in here — no checkout of the source repository, no
build step.

## The short version

**Linux / macOS**

```bash
./install.sh
```

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer asks which edition you want, generates the secrets for you, writes the configuration
and offers to start the stack. When it finishes it prints the panel address and the account to sign
in with.

Re-running it is safe: it will not overwrite an existing configuration without asking.

## Which edition?

| | **Community** | **Hosted** |
|---|---|---|
| For | your own machines | a multi-tenant service |
| Accounts | you create them as administrator | customers register themselves |
| Billing | none | usage-based, funded through FinVault |
| Needs FinVault | no | yes |

**Pick community** unless you are actually charging other people to run servers. It is the full
panel — deployments, live console and terminal, files, databases, backups, schedules, sharing and
teams. The only thing it leaves out is billing.

The editions are separate images, and the community images do not contain the hosted code at all.
That is why you choose an edition here rather than flipping a setting later: to switch, you install
the other one.

## What the installer sets up for you

Three values you should never have to invent yourself:

- **Administrator password** — the account you sign in with. Generated if you leave it blank.
- **`JWT_SECRET`** — signs the panel's login tokens. Anyone holding it can mint a token for any
  account, so it is generated as 32 random bytes.
- **`INTERNAL_API_TOKEN`** — the shared secret between the control plane and the node agent, whose
  API can start containers and open shells. Also generated.

The hosted edition additionally needs **`FINVAULT_MESSAGE_KEY`**, which must be identical to
FinVault's own. The installer will ask, and you can fill it in later.

## Doing it by hand

Nothing here obliges you to run the installer. If you would rather assemble your own stack — pointing
at a broker you already run, putting your own reverse proxy in front, or spreading agents across
machines — every image is documented in
[docs/images.md](https://github.com/Tombomeke-Studios/NexusInfra/blob/main/docs/images.md).

Each edition directory works on its own if you prefer:

```bash
cd community            # or: cd hosted
cp .env.example .env    # then fill in the required values
docker compose up -d
```

Both `community/README.md` and `hosted/README.md` cover the details, including running node agents on
additional machines and, for hosted, sharing a broker with FinVault.

## Upgrading

The compose files track a moving tag for their edition. To upgrade deliberately, pin a version in
`.env`:

```bash
NEXUSINFRA_VERSION=0.2.0-community   # or 0.2.0-hosted
docker compose pull && docker compose up -d
```

Database migrations are applied automatically when the control plane starts.

## Before exposing this to a network

The bundles are a starting point, not a hardened deployment. Put TLS in front of the panel, replace
the default broker credentials, and read the security notes in each edition's README.
