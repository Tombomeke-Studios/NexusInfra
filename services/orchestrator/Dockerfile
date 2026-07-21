# Multi-stage build. Debian slim (not alpine) + openssl, because Prisma's query
# and schema engines need OpenSSL and don't run on alpine/musl out of the box.
FROM node:18-slim AS builder
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

FROM node:18-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/orchestrator/dist ./services/orchestrator/dist
COPY --from=builder /app/services/orchestrator/package*.json ./services/orchestrator/
COPY --from=builder /app/services/orchestrator/prisma ./services/orchestrator/prisma
# prisma (CLI, for migrate deploy) + @prisma/client are runtime deps; the
# orchestrator postinstall regenerates the client against the copied schema.
RUN npm install --omit=dev
ENV PORT=9200
ENV DATABASE_URL=file:./orchestrator.db
EXPOSE 9200
# Apply migrations, then start. The SQLite file lives in the orchestrator dir.
WORKDIR /app/services/orchestrator
CMD ["sh", "-c", "npm run db:deploy && node dist/index.js"]
