# Multi-stage build (pattern from services/node-agent/Dockerfile).
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY services/orchestrator/ ./services/orchestrator/
RUN npm install
RUN npm run build --workspace=shared
# `build` also runs `prisma generate` (see services/orchestrator/package.json).
RUN npm run build --workspace=services/orchestrator

FROM node:18-alpine
WORKDIR /app
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
