# Sandbox daemon for agent worker containers (Docker-in-Docker, TLS, LAN egress blocked).
# Build context: repository root.
ARG DIND_IMAGE=docker:dind
FROM ${DIND_IMAGE}
ARG WORKBENCH_VERSION=dev
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/ai-workbench/
LABEL org.opencontainers.image.title="spatial-workbench-sandbox" \
      org.opencontainers.image.description="Isolated Docker daemon for Hermes agent workers" \
      org.opencontainers.image.version="${WORKBENCH_VERSION}"
COPY --chmod=0755 deploy/sandbox/entrypoint.sh /usr/local/bin/sandbox-entrypoint
# The agent connects as "sandbox"; include it in the generated server certificate.
ENV DOCKER_TLS_CERTDIR=/certs \
    DOCKER_TLS_SAN=DNS:sandbox
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
CMD []
