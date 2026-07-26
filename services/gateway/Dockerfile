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
ENV PORT=9400
EXPOSE 9400
CMD ["node", "services/gateway/dist/index.js"]
