# All-in-one NexusInfra (#203).
#
# One image, one command, a working panel. Everything the software needs runs
# inside: the orchestrator, a node agent, the control room, the gateway, nginx
# serving the dashboard, and a message broker.
#
#   docker run -d -v /var/run/docker.sock:/var/run/docker.sock \
#     -v nexusinfra:/data -p 8095:80 ghcr.io/tombomeke-studios/nexusinfra:community
#
# This exists alongside the six component images, not instead of them. It is for
# a single machine. Multi-node, an existing broker, an existing reverse proxy, or
# restarting one service without the others all want the components — see
# docs/images.md.
#
# Debian rather than Alpine because Prisma's engines need glibc and OpenSSL.

FROM node:18-slim AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
COPY shared/ ./shared/
COPY services/ ./services/
COPY dashboard/ ./dashboard/

ARG NEXUS_EDITION=community
ENV NEXUS_EDITION=$NEXUS_EDITION

# One install for the whole workspace: npm hoists the shared dependencies, so
# this is meaningfully smaller than the sum of the component images, which each
# carry their own copy of express, amqplib and the rest.
RUN npm install
# Generate the Prisma client explicitly. The workspace postinstall does not
# reliably place the platform query engine inside .prisma/client here, and the
# failure is invisible until the first database call at runtime.
RUN npm run db:generate --workspace=services/orchestrator \
 && if [ "$NEXUS_EDITION" = "hosted" ]; then npm run db:generate --workspace=services/billing-bridge; fi
RUN npm run build --workspace=shared
RUN npm run build --workspace=services/control-room \
 && npm run build --workspace=services/node-agent \
 && npm run build --workspace=services/orchestrator \
 && npm run build --workspace=services/gateway \
 && if [ "$NEXUS_EDITION" = "hosted" ]; then npm run build --workspace=services/billing-bridge; fi

# The dashboard is built for this edition, so a community image does not carry
# the billing UI. Verified rather than assumed.
RUN npm run build --workspace=dashboard \
 && cd dashboard && node scripts/verify-edition.mjs "$NEXUS_EDITION"

# Drop the build tooling before the runtime stage copies node_modules.
# TypeScript, tsx, Babel, esbuild, vite and vitest are all needed to *produce*
# the image and useless inside it, and shipping them means every user downloads
# a compiler they will never run (#204).
#
# The Prisma CLI survives this on purpose: it is a real dependency, because
# migrations are applied when the container starts.
RUN npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:18-slim

# s6-overlay supervises the processes and, unlike a bare shell loop, propagates
# signals and reaps zombies properly. RabbitMQ brings Erlang; it is the single
# largest thing here and is skipped at runtime when an external broker is given.
RUN apt-get update && apt-get install -y --no-install-recommends \
      nginx openssl ca-certificates xz-utils curl gnupg rabbitmq-server \
 && rm -rf /var/lib/apt/lists/*

ARG S6_OVERLAY_VERSION=3.1.6.2
RUN curl -sSLo /tmp/s6.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
 && tar -C / -Jxpf /tmp/s6.tar.xz \
 && curl -sSLo /tmp/s6-arch.tar.xz "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz" \
 && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
 && rm -f /tmp/s6.tar.xz /tmp/s6-arch.tar.xz

WORKDIR /app
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/services ./services
COPY --from=builder /app/dashboard/dist /usr/share/nginx/html

# Regenerate the Prisma client against *this* stage. The builder resolves
# OpenSSL 1.1 while the runtime installs OpenSSL 3.0, so a client generated
# earlier looks for an engine that is not here — and the failure only surfaces
# on the first database call, long after the build has passed.
RUN cd /app/services/orchestrator && npx prisma generate >/dev/null \
 && if [ -d /app/services/billing-bridge/prisma ]; then cd /app/services/billing-bridge && npx prisma generate >/dev/null || true; fi

COPY allinone/nginx.conf /etc/nginx/sites-available/default
COPY allinone/root /
RUN chmod -R +x /etc/s6-overlay/s6-rc.d /usr/local/bin

ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
# Stamped exactly as the component images are (#189), so this image runs as the
# edition it was built for and refuses to pretend otherwise.
RUN mkdir -p /etc/nexusinfra && printf '%s' "$NEXUS_EDITION" > /etc/nexusinfra/edition

# Everything that must survive a restart lives here: the databases, backups and
# broker state, plus the secrets generated on first start.
VOLUME /data
ENV DATA_DIR=/data
ENV NODE_ID=node-local

EXPOSE 80
ENTRYPOINT ["/init"]
