# AI Workbench job worker: OpenCode CLI in a throwaway container.
# The job engine runs one of these per subtask on the sandbox daemon, e.g.
#   docker run --user 10000:10000 -v /workspace:/workspace <image> opencode run -m opencode/big-pickle "..."
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=latest
ARG WORKBENCH_VERSION=dev

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/ai-workbench/
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl python3 python3-pip python3-venv jq ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --allow-scripts=opencode-ai "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && opencode --version

# Workers run as an arbitrary uid; keep every writable path under /tmp.
ENV HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    OPENCODE_DISABLE_AUTOUPDATE=1

LABEL org.opencontainers.image.title="spatial-workbench-worker" \
    org.opencontainers.image.description="OpenCode CLI worker for AI Workbench jobs" \
      org.opencontainers.image.version="${WORKBENCH_VERSION}"

WORKDIR /workspace
CMD ["opencode", "--help"]
