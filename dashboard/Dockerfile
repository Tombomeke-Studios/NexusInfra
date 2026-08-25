# Build the static dashboard, then serve it with nginx. nginx also reverse-proxies
# /api to the Orchestrator so the browser talks to a single origin (see nginx.conf).
#
# The build is per edition (#190): a community bundle does not merely hide the
# billing UI, it does not contain it. The verification step below reads the built
# bundle and fails the build if that stops being true — tree-shaking is easy to
# break by accident, and the only symptom would be a self-hosted panel shipping
# code it can never run.
FROM node:18-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

ARG NEXUS_EDITION=community
ENV NEXUS_EDITION=$NEXUS_EDITION
RUN npm run build
RUN node scripts/verify-edition.mjs "$NEXUS_EDITION"

FROM nginx:alpine
ARG APP_VERSION=0.0.0-dev
ARG NEXUS_EDITION=community
ENV APP_VERSION=$APP_VERSION
# Stamped the same way the services are (#189), so what an image is can be read
# off the image rather than inferred from its tag.
RUN mkdir -p /etc/nexusinfra && printf '%s' "$NEXUS_EDITION" > /etc/nexusinfra/edition
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
