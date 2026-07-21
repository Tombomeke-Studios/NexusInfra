# Build the static dashboard, then serve it with nginx. nginx also reverse-proxies
# /api to the Orchestrator so the browser talks to a single origin (see nginx.conf).
FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
