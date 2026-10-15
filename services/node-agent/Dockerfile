# Multi-stage build (pattern from services/control-room/Dockerfile)
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY services/node-agent/ ./services/node-agent/
RUN npm install
RUN npm run build --workspace=shared
RUN npm run build --workspace=services/node-agent

FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/node-agent/dist ./services/node-agent/dist
COPY --from=builder /app/services/node-agent/package*.json ./services/node-agent/
RUN npm install --omit=dev
# Build identity (#179, #189). The edition is stamped into the image as a file,
# not left to the environment: pulling the :hosted image is enough, and a stray
# NEXUS_EDITION cannot turn this build into the other edition (it would be
# missing the code to run as one). See shared/src/edition.ts.
ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
RUN mkdir -p /etc/nexusinfra && printf '%s' "$NEXUS_EDITION" > /etc/nexusinfra/edition
# Backups are kept on a volume by default (#357). The agent used to write them
# to the container's temp directory unless BACKUP_DIR said otherwise — and the
# bundles mounted a volume here without ever setting it, so every upgrade
# (which recreates the container) deleted every local backup while the panel
# went on listing them.
ENV BACKUP_DIR=/var/lib/nexusinfra/backups
RUN mkdir -p /var/lib/nexusinfra/backups
VOLUME ["/var/lib/nexusinfra/backups"]
ENV PORT=9100
EXPOSE 9100
# Requires the host Docker socket mounted at runtime, e.g.
#   -v /var/run/docker.sock:/var/run/docker.sock
CMD ["node", "services/node-agent/dist/index.js"]
