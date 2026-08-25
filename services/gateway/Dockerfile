# Multi-stage build (pattern shared by the other services).
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY services/gateway/ ./services/gateway/
RUN npm install
RUN npm run build --workspace=shared
RUN npm run build --workspace=services/gateway

FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/shared/package*.json ./shared/
COPY --from=builder /app/services/gateway/dist ./services/gateway/dist
COPY --from=builder /app/services/gateway/package*.json ./services/gateway/
RUN npm install --omit=dev
# Build identity (#179, #189). The edition is stamped into the image as a file,
# not left to the environment: pulling the :hosted image is enough, and a stray
# NEXUS_EDITION cannot turn this build into the other edition (it would be
# missing the code to run as one). See shared/src/edition.ts.
ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
RUN mkdir -p /etc/nexusinfra && printf '%s' "$NEXUS_EDITION" > /etc/nexusinfra/edition
ENV PORT=9400
EXPOSE 9400
CMD ["node", "services/gateway/dist/index.js"]
