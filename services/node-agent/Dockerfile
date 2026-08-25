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
# Build identity (#179). These are defaults the release workflow bakes in — the
# runtime environment can still override NEXUS_EDITION, so one image is never
# locked to an edition; the per-edition tags exist to make the intended one
# obvious rather than to enforce it.
ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
ENV NEXUS_EDITION=$NEXUS_EDITION
ENV PORT=9100
EXPOSE 9100
# Requires the host Docker socket mounted at runtime, e.g.
#   -v /var/run/docker.sock:/var/run/docker.sock
CMD ["node", "services/node-agent/dist/index.js"]
