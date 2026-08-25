#!/usr/bin/env bash
# NexusInfra installer (#191).
#
# Picks an edition, generates the secrets, writes .env and offers to start the
# stack. The alternative is asking people to read a README and hand-generate
# three random values before anything runs, which is where self-hosters give up.
#
# Safe to re-run: an existing .env is never overwritten without being asked.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

bold "NexusInfra installer"
say

command -v docker >/dev/null 2>&1 || die "Docker is required but was not found. Install Docker, then run this again."
docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 ('docker compose'). Update Docker, then run this again."

# ── Which edition ────────────────────────────────────────────────────────────
EDITION="${1:-}"
if [ -z "$EDITION" ]; then
  say "Which edition would you like to run?"
  say
  say "  1) community  — self-hosted panel for your own machines. No billing."
  say "  2) hosted     — multi-tenant, with usage billing through FinVault."
  say
  read -rp "Choose [1]: " choice
  case "${choice:-1}" in
    1|community|"") EDITION=community ;;
    2|hosted)       EDITION=hosted ;;
    *) die "Not one of the options: $choice" ;;
  esac
fi
[ -d "$EDITION" ] || die "No bundle for '$EDITION' in this archive."

say
bold "Setting up the $EDITION edition"
cd "$EDITION"

# ── Secrets ──────────────────────────────────────────────────────────────────
# A weak secret here is not cosmetic: JWT_SECRET mints tokens for any account,
# and INTERNAL_API_TOKEN reaches an API that can start containers.
random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ -f .env ]; then
  warn "A .env already exists here."
  read -rp "Keep it and skip configuration? [Y/n]: " keep
  case "${keep:-Y}" in
    [Nn]*) mv .env ".env.backup.$(date +%Y%m%d%H%M%S)"; say "Previous .env kept as a .env.backup.* file." ;;
    *) say "Keeping the existing .env." ; SKIP_ENV=1 ;;
  esac
fi

if [ -z "${SKIP_ENV:-}" ]; then
  read -rp "Administrator email [admin@local]: " ADMIN_EMAIL
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local}"

  # Read the password without echoing it, and never accept an empty one.
  while :; do
    read -rsp "Administrator password (leave blank to generate one): " ADMIN_PASSWORD; echo
    if [ -z "$ADMIN_PASSWORD" ]; then
      ADMIN_PASSWORD="$(random_secret | cut -c1-20)"
      say "Generated a password — it is written to .env, keep it safe."
      break
    fi
    read -rsp "Confirm password: " confirm; echo
    [ "$ADMIN_PASSWORD" = "$confirm" ] && break
    warn "Those did not match, try again."
  done

  cp .env.example .env
  # Portable in-place edit: BSD and GNU sed disagree about -i.
  set_var() {
    local key="$1" value="$2"
    sed "s|^${key}=.*|${key}=${value}|" .env > .env.tmp && mv .env.tmp .env
  }
  set_var ADMIN_EMAIL "$ADMIN_EMAIL"
  set_var ADMIN_PASSWORD "$ADMIN_PASSWORD"
  set_var JWT_SECRET "$(random_secret)"
  set_var INTERNAL_API_TOKEN "$(random_secret)"

  if [ "$EDITION" = "hosted" ]; then
    say
    warn "The hosted edition exchanges payment events with FinVault."
    warn "FINVAULT_MESSAGE_KEY must be identical on both sides or neither can read the other's events."
    read -rp "FinVault message key (blank to fill in later): " KEY
    [ -n "$KEY" ] && set_var FINVAULT_MESSAGE_KEY "$KEY"
    [ -z "$KEY" ] && warn "Left blank — set FINVAULT_MESSAGE_KEY in $EDITION/.env before starting."
  fi

  chmod 600 .env 2>/dev/null || true
  say
  say "Wrote $EDITION/.env with generated secrets."
fi

# ── Start ────────────────────────────────────────────────────────────────────
say
read -rp "Start NexusInfra now? [Y/n]: " start
case "${start:-Y}" in
  [Nn]*)
    say
    say "Not started. When you are ready:"
    say "  cd $EDITION && docker compose up -d"
    exit 0
    ;;
esac

say
say "Pulling images and starting…"
docker compose pull
docker compose up -d

PORT="$(grep -E '^DASHBOARD_PORT=' .env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8095}"

say
bold "NexusInfra is running."
say "  Panel:  http://localhost:${PORT}"
say "  Sign in as: ${ADMIN_EMAIL:-the address in .env}"
say
say "  Logs:   cd $EDITION && docker compose logs -f"
say "  Stop:   cd $EDITION && docker compose down"
