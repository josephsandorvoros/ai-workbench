# AI Workbench agent image: upstream Hermes Agent + OpenCode + companion API.
# Build context: repository root (homelab-ai-dashboard/).
ARG HERMES_IMAGE=nousresearch/hermes-agent:latest
FROM ${HERMES_IMAGE}

ARG OPENCODE_VERSION=latest
ARG WORKBENCH_VERSION=dev
# Tag list of the repo this image is published from; forks override it.
ARG WORKBENCH_UPDATE_URL=https://api.github.com/repos/josephsandorvoros/ai-workbench/tags?per_page=50

USER root

RUN rm -f /etc/cont-init.d/02-reconcile-profiles

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/ai-workbench/
COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /usr/local/bin/uv
RUN uv --version \
    && uv pip install --python /opt/hermes/.venv/bin/python PyYAML==6.0.3 \
    && /opt/hermes/.venv/bin/python -c "import yaml"

RUN npm install -g --prefix /usr/local --allow-scripts=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && opencode --version

COPY --chmod=0755 dashboard_server.py /opt/workbench/dashboard_server.py
COPY hermes_live.py /opt/workbench/hermes_live.py
COPY jobs_engine.py /opt/workbench/jobs_engine.py
COPY opencode_config.py /opt/workbench/opencode_config.py
COPY hermes_config.py /opt/workbench/hermes_config.py
COPY provider_catalog.py /opt/workbench/provider_catalog.py
COPY app_preview.py /opt/workbench/app_preview.py
COPY hermes_runtime.py /opt/workbench/hermes_runtime.py
COPY --chmod=0755 deploy/agent/hermes /opt/workbench/bin/hermes
COPY free_models.py /opt/workbench/free_models.py
COPY speech_services.py /opt/workbench/speech_services.py
COPY --chmod=0755 deploy/agent/workbench_mcp.py /opt/workbench/workbench_mcp.py
COPY --chmod=0755 deploy/agent/bootstrap.py /opt/workbench/bootstrap.py
COPY --chmod=0755 deploy/agent/sandbox_reaper.py /opt/workbench/sandbox_reaper.py
COPY --chmod=0755 deploy/agent/cont-init.d/50-workbench-bootstrap /etc/cont-init.d/50-workbench-bootstrap
COPY --chmod=0755 deploy/agent/workbench-update /usr/local/bin/workbench-update
COPY deploy/agent/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
RUN chmod 0755 /etc/s6-overlay/s6-rc.d/workbench-api/run /etc/s6-overlay/s6-rc.d/workbench-api/finish \
    /etc/s6-overlay/s6-rc.d/opencode-server/run /etc/s6-overlay/s6-rc.d/opencode-server/finish \
    /etc/s6-overlay/s6-rc.d/sandbox-reaper/run /etc/s6-overlay/s6-rc.d/hermes-serve/run

ENV WORKBENCH_API=1 \
    WORKBENCH_VERSION=${WORKBENCH_VERSION} \
    WORKBENCH_UPDATE_URL=${WORKBENCH_UPDATE_URL} \
    NPM_CONFIG_PREFIX=/opt/data/.local \
    WORKBENCH_API_PORT=8080 \
    OPENCODE_SERVER=1 \
    OPENCODE_SERVER_PORT=4096 \
    WORKBENCH_ENV_FILE=/opt/data/workbench.env \
    HERMES_AGENT_DIR=/opt/hermes \
    HERMES_PYTHON=/opt/hermes/.venv/bin/python \
    HERMES_CLI_PATH=/opt/workbench/bin/hermes \
    HERMES_IMAGE_DIR=/opt/hermes \
    HERMES_IMAGE_PYTHON=/opt/hermes/.venv/bin/python \
    WORKBENCH_HERMES_MANAGED=1 \
    PATH="/opt/workbench/bin:${PATH}" \
    HERMES_WORKDIR=/workspace \
    WORKSPACE_ROOT=/workspace \
    HERMES_WRITE_SAFE_ROOT=/opt/data:/workspace \
    WIKI_ROOT=/workspace/wiki \
    WIKI_PATH=/workspace/wiki \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642

LABEL org.opencontainers.image.title="spatial-workbench-agent" \
    org.opencontainers.image.description="Hermes Agent gateway + OpenCode + AI Workbench companion API" \
      org.opencontainers.image.version="${WORKBENCH_VERSION}"

VOLUME ["/opt/data", "/workspace"]
EXPOSE 8080 8642

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${WORKBENCH_API_PORT}/api/config" >/dev/null || exit 1

CMD ["python3", "/opt/workbench/hermes_runtime.py", "supervise", "gateway"]
