# NexusInfra — Community edition

The standalone, self-hosted server panel. You own the machines, so there is no billing and no
dependency on anything outside this directory.

## Run it

```bash
cp .env.example .env      # set ADMIN_PASSWORD, JWT_SECRET and INTERNAL_API_TOKEN
docker compose up -d
```

Open **http://localhost:8095** and sign in as `ADMIN_EMAIL` with the password you set.

Everything runs from published images — you do not need a checkout of the source to use this.

## What you get

Deploy any Docker image (or a game preset) as a managed server, with CPU/RAM limits, a live console
and interactive terminal, a file browser, managed databases, backups and cron schedules. Share a
server with other people by email, or with a whole team — see
[the sharing model](https://github.com/Tombomeke-Studios/NexusInfra/blob/main/docs/security.md).

**Accounts are created by an administrator here.** Open sign-up belongs to the hosted edition; a
self-hosted panel that controls Docker should not have a public registration form. Add people from
the panel, then share servers with them.

## Adding more machines

A node is just a Node Agent process pointed at this broker. To add a second machine, run the
`nexusinfra-node-agent` image there with a distinct `NODE_ID`, the same `INTERNAL_API_TOKEN`, and
`RABBITMQ_URL` pointing at this host's broker — over an authenticated, TLS-protected connection, not
the defaults in `.env.example`. It registers itself, and the scheduler starts placing servers on it.

## Upgrading

The image tags in `docker-compose.yml` default to the moving `community` tag. Pin
`NEXUSINFRA_VERSION` in `.env` to a released version if you would rather upgrade deliberately:

```bash
NEXUSINFRA_VERSION=0.2.0-community
docker compose pull && docker compose up -d
```

Database migrations are applied automatically when the Orchestrator starts.

## Security notes

- The Node Agent's port is deliberately **not** published: it is an internal API that can start
  containers and open shells in them. Only the Orchestrator should reach it.
- The broker is likewise unpublished. Publish it only if you run agents on other machines.
- Full detail: [docs/security.md](https://github.com/Tombomeke-Studios/NexusInfra/blob/main/docs/security.md).
