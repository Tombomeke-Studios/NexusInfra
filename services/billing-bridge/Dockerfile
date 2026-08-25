# Multi-stage build. Debian slim (not alpine) + openssl, because Prisma's query
# and schema engines need OpenSSL and don't run on alpine/musl out of the box.
FROM node:18-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY services/billing-bridge/ ./services/billing-bridge/
RUN npm install
RUN npm run build --workspace=shared
# `build` also runs `prisma generate` (see services/billing-bridge/package.json).
RUN npm run build --workspace=services/billing-bridge

FROM node:18-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/billing-bridge/dist ./services/billing-bridge/dist
COPY --from=builder /app/services/billing-bridge/package*.json ./services/billing-bridge/
COPY --from=builder /app/services/billing-bridge/prisma ./services/billing-bridge/prisma
# prisma (CLI, for migrate deploy) + @prisma/client are runtime deps; the
# postinstall regenerates the client against the copied schema.
RUN npm install --omit=dev
# Build identity (#179, #189). The edition is stamped into the image as a file,
# not left to the environment: pulling the :hosted image is enough, and a stray
# NEXUS_EDITION cannot turn this build into the other edition (it would be
# missing the code to run as one). See shared/src/edition.ts.
ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
RUN mkdir -p /etc/nexusinfra && printf '%s' "$NEXUS_EDITION" > /etc/nexusinfra/edition
ENV PORT=9300
ENV DATABASE_URL=file:./billing.db
ENV NEXUS_EDITION=community
EXPOSE 9300
# Apply migrations, then start. The SQLite file lives in the billing-bridge dir.
WORKDIR /app/services/billing-bridge
CMD ["sh", "-c", "npm run db:deploy && node dist/index.js"]
