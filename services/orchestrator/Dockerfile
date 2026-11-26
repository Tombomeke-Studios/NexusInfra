# Multi-stage build. Debian slim (not alpine) + openssl, because Prisma's query
# and schema engines need OpenSSL and don't run on alpine/musl out of the box.
FROM node:24-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY services/orchestrator/ ./services/orchestrator/
RUN npm install
RUN npm run build --workspace=shared
# `build` also runs `prisma generate` (see services/orchestrator/package.json).
RUN npm run build --workspace=services/orchestrator

# ── migrate: applies the migrations, then exits (#192) ──────────────────────
# Everything the runtime has, plus the Prisma CLI and its schema engine (~60 MB),
# which only `migrate deploy` uses. Published as `orchestrator-migrate`; the
# compose files run it before the orchestrator on every start. Also the image to
# run scripts/sqlite-to-postgres.mjs in, since that migrates its target too.
# Build it with `--target migrate`.
FROM node:24-slim AS migrate
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/orchestrator/dist ./services/orchestrator/dist
COPY --from=builder /app/services/orchestrator/package*.json ./services/orchestrator/
COPY --from=builder /app/services/orchestrator/prisma ./services/orchestrator/prisma
# db:deploy picks SQLite or PostgreSQL migrations by DATABASE_URL (#241), and the
# SQLite → PostgreSQL copy lives there too; both are repo-root scripts.
COPY scripts/ ./scripts/
# The postinstall generates both Prisma clients against the copied schemas.
RUN npm install --omit=dev
ENV DATABASE_URL=file:./orchestrator.db
WORKDIR /app/services/orchestrator
CMD ["npm", "run", "db:deploy"]

# The same tree without what only migrations use. Removing files in a later layer
# of one image does not shrink it, so the runtime copies this pruned tree instead.
# Nothing else depends on these packages: @prisma/client names `prisma` only as an
# optional peer, and both generated clients carry their own query engine.
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
ENV PORT=9200
ENV DATABASE_URL=file:./orchestrator.db
EXPOSE 9200
# No migrations here: the migrate image applies them, and the orchestrator
# refuses to start while any are missing (shared/src/migrations.ts).
WORKDIR /app/services/orchestrator
CMD ["node", "dist/index.js"]
