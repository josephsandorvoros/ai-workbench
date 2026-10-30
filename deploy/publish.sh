#!/usr/bin/env bash
# Build all images and push them to a registry (e.g. your Forgejo instance).
#
#   docker login forgejo.example.com
#   WORKBENCH_IMAGE_PREFIX=forgejo.example.com/owner ./publish.sh v0.1.0
#
# Pushes <prefix>/spatial-workbench-{agent,web,sandbox,worker}:<version> and :latest.
set -euo pipefail

cd "$(dirname "$0")"
version="${1:?usage: publish.sh <version>}"
prefix="${WORKBENCH_IMAGE_PREFIX:?set WORKBENCH_IMAGE_PREFIX (e.g. forgejo.example.com/owner)}"

cleanup_docker_cache() {
    local status=$?
    trap - EXIT
    echo "DIND storage before cleanup:"
    docker system df || true
    if ! docker system prune --all --force; then
        echo "WARNING: DIND cache cleanup failed; inspect the runner's Docker daemon." >&2
        if [[ "$status" -eq 0 ]]; then
            status=1
        fi
    fi
    echo "DIND storage after cleanup:"
    docker system df || true
    exit "$status"
}
trap cleanup_docker_cache EXIT

export WORKBENCH_IMAGE_PREFIX="$prefix" WORKBENCH_TAG="$version"

# The publish runner uses persistent DIND storage: prune unused cache/images, never volumes.
docker compose -f docker-compose.yml -f docker-compose.build.yml --profile sandbox build --pull

for name in spatial-workbench-agent spatial-workbench-web spatial-workbench-sandbox spatial-workbench-worker; do
    docker tag "$prefix/$name:$version" "$prefix/$name:latest"
    docker push "$prefix/$name:$version"
    docker push "$prefix/$name:latest"
done
echo "Published $prefix/spatial-workbench-{agent,web,sandbox,worker}:$version"
