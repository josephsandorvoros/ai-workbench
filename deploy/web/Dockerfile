# AI Workbench web image: static Vite build served by Caddy, which also
# proxies /api, /hermes-gw and /llm. Build context: repository root.
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 libfreetype6 \
    && rm -rf /var/lib/apt/lists/*
COPY spatial-workbench/package.json spatial-workbench/package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN npm audit --audit-level=moderate
COPY spatial-workbench/ ./
COPY deploy/README.md /deploy/README.md
COPY LICENSE THIRD_PARTY_NOTICES.md /
COPY licenses/ /licenses/
RUN npm test && npm run build

FROM caddy:2-alpine
ARG WORKBENCH_VERSION=dev
LABEL org.opencontainers.image.title="spatial-workbench-web" \
    org.opencontainers.image.description="AI Workbench UI (static) + reverse proxy" \
      org.opencontainers.image.version="${WORKBENCH_VERSION}"
COPY --from=build /src/dist /srv
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/ai-workbench/
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/web/entrypoint.sh /usr/local/bin/workbench-web
RUN touch /etc/caddy/auth.caddy /etc/caddy/llm-auth.caddy /etc/caddy/allow.caddy
ENV WORKBENCH_PORT=1420
EXPOSE 1420
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${WORKBENCH_PORT}/" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/workbench-web"]
