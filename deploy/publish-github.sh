#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: publish-github.sh <release-tag>}"
source_prefix="${WORKBENCH_IMAGE_PREFIX:-forgejo.hybridcloudhq.com/jsvoros}"
destination_prefix="ghcr.io/josephsandorvoros"
repository="https://github.com/josephsandorvoros/ai-workbench.git"
script_directory="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$script_directory/check-license-review.mjs"
: "${REGISTRY_USERNAME:?set REGISTRY_USERNAME}"
: "${REGISTRY_PASSWORD:?set REGISTRY_PASSWORD}"
: "${REPO_TOKEN_GITHUB:?set REPO_TOKEN_GITHUB}"
: "${GHCR_TOKEN:?set GHCR_TOKEN}"
[[ "$version" == v* ]] || { echo "Only v* release tags can be published." >&2; exit 1; }
git check-ref-format "refs/tags/$version"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "refs/tags/$version^{commit}")" ]] || {
    echo "Checkout does not match release tag $version." >&2
    exit 1
}

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
    *Username*) printf '%s\n' josephsandorvoros ;;
    *Password*) printf '%s\n' "$REPO_TOKEN_GITHUB" ;;
    *) exit 1 ;;
esac
ASKPASS
chmod 700 "$scratch/askpass"
export GIT_ASKPASS="$scratch/askpass" GIT_TERMINAL_PROMPT=0
source_directory="$(git rev-parse --show-toplevel)"
snapshot_status="$(python3 "$script_directory/github_snapshot.py" "$source_directory" "$scratch/public" "$version")"
if [[ "$snapshot_status" == already-published ]]; then
    echo "$version is already published with identical public source; leaving main and latest unchanged."
    exit 0
fi
[[ "$snapshot_status" == prepared ]] || { echo "Unexpected public snapshot status." >&2; exit 1; }
export REGISTRY_AUTH_FILE="$scratch/auth.json"
printf '%s' "$REGISTRY_PASSWORD" | skopeo login --authfile "$REGISTRY_AUTH_FILE" \
    --username "$REGISTRY_USERNAME" --password-stdin "${source_prefix%%/*}"
printf '%s' "$GHCR_TOKEN" | skopeo login --authfile "$REGISTRY_AUTH_FILE" \
    --username josephsandorvoros --password-stdin ghcr.io

for name in spatial-workbench-agent spatial-workbench-web spatial-workbench-sandbox spatial-workbench-worker; do
    skopeo copy --all --preserve-digests \
        "docker://$source_prefix/$name:$version" "docker://$destination_prefix/$name:$version"
done

for name in spatial-workbench-agent spatial-workbench-web spatial-workbench-sandbox spatial-workbench-worker; do
    skopeo copy --all --preserve-digests \
        "docker://$destination_prefix/$name:$version" "docker://$destination_prefix/$name:latest"
done

git -C "$scratch/public" -c credential.helper= push --atomic "$repository" \
    HEAD:refs/heads/main "refs/tags/$version:refs/tags/$version"
echo "Published $version images and a clean public source snapshot to GitHub."