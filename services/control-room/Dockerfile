# Multi-stage build (pattern from FinVault/services/gateway/Dockerfile)
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY services/control-room/ ./services/control-room/
RUN npm install
RUN npm run build --workspace=shared
RUN npm run build --workspace=services/control-room

FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/control-room/dist ./services/control-room/dist
COPY --from=builder /app/services/control-room/package*.json ./services/control-room/
RUN npm install --omit=dev
# Build identity (#179). These are defaults the release workflow bakes in — the
# runtime environment can still override NEXUS_EDITION, so one image is never
# locked to an edition; the per-edition tags exist to make the intended one
# obvious rather than to enforce it.
ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
ENV NEXUS_EDITION=$NEXUS_EDITION
ENV PORT=9000
EXPOSE 9000
CMD ["node", "services/control-room/dist/index.js"]
