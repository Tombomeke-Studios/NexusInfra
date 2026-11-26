# Multi-stage build. Debian slim (not alpine) + openssl, because Prisma's query
# and schema engines need OpenSSL and don't run on alpine/musl out of the box.
FROM node:24-slim AS builder
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

# ── migrate: applies the migrations, then exits (#192) ──────────────────────
# Everything the runtime has, plus the Prisma CLI and its schema engine, which
# only `migrate deploy` uses. Published as `billing-bridge-migrate`; the hosted
# compose file runs it before the bridge on every start. Build with `--target migrate`.
FROM node:24-slim AS migrate
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/billing-bridge/dist ./services/billing-bridge/dist
COPY --from=builder /app/services/billing-bridge/package*.json ./services/billing-bridge/
COPY --from=builder /app/services/billing-bridge/prisma ./services/billing-bridge/prisma
# db:deploy picks SQLite or PostgreSQL migrations by DATABASE_URL (#241), and the
# SQLite → PostgreSQL copy lives there too; both are repo-root scripts.
COPY scripts/ ./scripts/
# The postinstall generates both Prisma clients against the copied schemas.
RUN npm install --omit=dev
ENV DATABASE_URL=file:./billing.db
WORKDIR /app/services/billing-bridge
CMD ["npm", "run", "db:deploy"]

# The same tree without what only migrations use; see the orchestrator's Dockerfile.
FROM migrate AS pruned
RUN cd /app/node_modules \
 && rm -rf prisma .bin/prisma @prisma/engines @prisma/engines-version @prisma/fetch-engine @prisma/get-platform @prisma/debug

# ── runtime (the default target) ────────────────────────────────────────────
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=pruned /app /app
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
# No ENV NEXUS_EDITION here, on purpose (#292). The stamp above is the only
# source: baking the variable in made the hosted image contradict its own stamp
# and refuse to start — in the only edition this service exists for.
EXPOSE 9300
# No migrations here: the migrate image applies them, and the bridge refuses to
# start while any are missing (shared/src/migrations.ts).
WORKDIR /app/services/billing-bridge
CMD ["node", "dist/index.js"]
