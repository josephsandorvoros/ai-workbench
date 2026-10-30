#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${WORKBENCH_INSTALL_DIR:-/opt/spatial-workbench}"
DEFAULT_TAG="${WORKBENCH_INSTALL_TAG:-latest}"
DRY_RUN=0
umask 077

die() { printf 'Install failed: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) die "usage: bash install.sh [--dry-run]" ;;
esac

ask() {
  local answer
  printf '%s [%s]: ' "$1" "$2" >&2
  IFS= read -r answer || die "input ended before setup was complete"
  printf '%s' "${answer:-$2}"
}

ask_yes() {
  local answer
  answer="$(ask "$1 (yes/no)" "$2")"
  case "$answer" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    [Nn]|[Nn][Oo]) return 1 ;;
    *) die "answer yes or no" ;;
  esac
}

ask_secret() {
  local answer
  printf '%s: ' "$1" >&2
  if [[ -t 0 ]]; then
    IFS= read -rs answer || die "could not read API key"
    printf '\n' >&2
  else
    IFS= read -r answer || die "could not read API key"
  fi
  printf '%s' "$answer"
}

choose_connection() {
  local mode
  mode="$(ask "$1 endpoint (provider/hermes/custom)" provider)"
  CONNECTION_BASE_URL=
  CONNECTION_KEY=
  case "$mode" in
    provider)
      printf 'Hosted providers may send prompts outside your private network.\n' >&2
      CONNECTION_MODEL="$(ask "$1 provider/model" 'opencode/big-pickle')"
      [[ "$CONNECTION_MODEL" == */* ]] || die "hosted models require provider/model"
      CONNECTION_KEY="$(ask_secret "$1 API key (Enter if not needed)")"
      ;;
    hermes)
      CONNECTION_BASE_URL="$LLM_BASE_URL"
      CONNECTION_MODEL="$(ask "$1 model identifier" "$LLM_MODEL")"
      CONNECTION_KEY="$(ask_secret "$1 API key (Enter to reuse the Hermes key)")"
      CONNECTION_KEY="${CONNECTION_KEY:-$LLM_API_KEY}"
      ;;
    custom)
      CONNECTION_BASE_URL="$(ask "$1 OpenAI-compatible URL (include /v1)" '')"
      [[ "$CONNECTION_BASE_URL" =~ ^https?://[^[:space:]]+$ && "$CONNECTION_BASE_URL" != *@* ]] || die "enter a valid http(s) endpoint without embedded credentials"
      CONNECTION_MODEL="$(ask "$1 model identifier" '')"
      CONNECTION_KEY="$(ask_secret "$1 API key (Enter if not needed)")"
      ;;
    *) die "endpoint choice must be provider, hermes, or custom" ;;
  esac
  [[ -n "$CONNECTION_MODEL" && ! "$CONNECTION_MODEL" =~ [[:space:]] ]] || die "a model identifier without whitespace is required"
}

printf 'AI Workbench setup (local SSH access only)\n'
LLM_BASE_URL="$(ask 'OpenAI-compatible model URL (include /v1)' '')"
[[ "$LLM_BASE_URL" =~ ^https?://[^[:space:]]+$ ]] || die "enter a valid http(s) model URL"
LLM_MODEL="$(ask 'Model identifier' '')"
[[ -n "$LLM_MODEL" ]] || die "model identifier is required"
printf 'Model API key (Enter if not needed): ' >&2
if [[ -t 0 ]]; then
  IFS= read -rs LLM_API_KEY || die "could not read model key"
  printf '\n' >&2
else
  IFS= read -r LLM_API_KEY || die "could not read model key"
fi
WORKBENCH_TAG="$(ask 'Published image tag (latest or vX.Y.Z)' "$DEFAULT_TAG")"
[[ "$WORKBENCH_TAG" == latest || "$WORKBENCH_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "use latest or a version tag such as v0.1.48"
if [[ "$WORKBENCH_TAG" == latest ]]; then
  WORKBENCH_SOURCE_REF="${WORKBENCH_INSTALL_SOURCE_REF:-main}"
else
  WORKBENCH_SOURCE_REF="${WORKBENCH_INSTALL_SOURCE_REF:-$WORKBENCH_TAG}"
fi
[[ "$WORKBENCH_SOURCE_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$WORKBENCH_SOURCE_REF" != *..* ]] || die "invalid Compose source ref"
WORKBENCH_PORT="$(ask 'Workbench port on the VM' '1420')"
[[ "$WORKBENCH_PORT" =~ ^[0-9]+$ ]] && (( WORKBENCH_PORT >= 1 && WORKBENCH_PORT <= 65535 )) || die "invalid port"
ssh_user="${SUDO_USER:-$(id -un)}"
SSH_TARGET="$(ask 'SSH destination (user@host)' "${ssh_user}@$(hostname -f 2>/dev/null || hostname)")"
[[ "$SSH_TARGET" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || die "invalid SSH destination"
choose_connection 'Main OpenCode'
OPENCODE_MODEL="$CONNECTION_MODEL"
OPENCODE_CUSTOM_BASE_URL="$CONNECTION_BASE_URL"
OPENCODE_CUSTOM_API_KEY=
OPENCODE_MAIN_API_KEY=
if [[ -n "$OPENCODE_CUSTOM_BASE_URL" ]]; then
  OPENCODE_CUSTOM_API_KEY="$CONNECTION_KEY"
else
  OPENCODE_MAIN_API_KEY="$CONNECTION_KEY"
fi
if ask_yes 'Enable isolated worker sandbox for Jobs? Uses privileged Docker-in-Docker on this VM' yes; then
  JOBS_SANDBOX=1
else
  JOBS_SANDBOX=0
fi
choose_connection 'Default job workers'
WORKER_MODEL="$CONNECTION_MODEL"
WORKER_BASE_URL="$CONNECTION_BASE_URL"
WORKER_API_KEY="$CONNECTION_KEY"
SANDBOX_ALLOW_LAN=
if [[ "$JOBS_SANDBOX" == 1 && -n "$WORKER_BASE_URL" ]]; then
  printf 'Workers block LAN access by default. For a LAN endpoint, allow only its server IP/CIDR.\n' >&2
  SANDBOX_ALLOW_LAN="$(ask 'Worker LAN exceptions (IPs/CIDRs, comma-separated; empty for public endpoints)' '')"
  [[ "$SANDBOX_ALLOW_LAN" != *[!0-9A-Fa-f:./,]* ]] || die "LAN exceptions must be IPs/CIDRs separated by commas"
fi
AGENT_SANDBOX=0

printf '\nInstall directory: %s\nImage tag: %s\nCompose source ref: %s\nUI bind: 127.0.0.1:%s\nJobs worker sandbox: %s\nHermes terminal sandbox: %s\n' \
  "$INSTALL_DIR" "$WORKBENCH_TAG" "$WORKBENCH_SOURCE_REF" "$WORKBENCH_PORT" "$JOBS_SANDBOX" "$AGENT_SANDBOX"
[[ "$INSTALL_DIR" = /* && "$INSTALL_DIR" != / ]] || die "install directory must be an absolute path"
if (( DRY_RUN )); then
  printf 'Dry run: no files written and no Docker commands executed.\n'
  exit 0
fi

[[ "$(uname -s)" = Linux ]] || die "this installer requires Linux"
[[ ! -e "$INSTALL_DIR" ]] || die "$INSTALL_DIR already exists; this installer will not overwrite it"
if (( EUID != 0 )); then
  command -v sudo >/dev/null || die "sudo is needed to install Docker and write $INSTALL_DIR"
fi

run_root() {
  if (( EUID == 0 )); then "$@"; else sudo "$@"; fi
}

install_docker() {
  if command -v docker >/dev/null; then
    run_root docker info >/dev/null || die "Docker is installed but its daemon is unavailable"
    run_root docker compose version >/dev/null || die "Docker is installed without the Compose plugin"
    return
  fi
  # Only these two distributions use this exact repository/keyring setup.
  . /etc/os-release
  case "$ID" in ubuntu|debian) ;; *) die "automatic Docker installation supports Ubuntu and Debian only" ;; esac
  command -v apt-get >/dev/null && command -v dpkg >/dev/null || die "apt and dpkg are required"
  if dpkg-query -W -f='${db:Status-Status}' docker.io 2>/dev/null | grep -qx installed; then
    die "distro Docker package is installed; resolve the package conflict manually"
  fi
  ask_yes 'Install Docker Engine and Compose from the official Docker repository?' yes || die "Docker installation declined"
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl
  run_root install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$scratch/docker.asc"
  run_root install -m 0644 "$scratch/docker.asc" /etc/apt/keyrings/docker.asc
  suite="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  arch="$(dpkg --print-architecture)"
  printf 'Types: deb\nURIs: https://download.docker.com/linux/%s\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
    "$ID" "$suite" "$arch" | run_root tee /etc/apt/sources.list.d/docker.sources >/dev/null
  run_root apt-get update
  run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_root systemctl enable --now docker
  run_root docker info >/dev/null && run_root docker compose version >/dev/null || die "Docker did not start correctly"
}

env_line() {
  [[ "$2" != *$'\n'* && "$2" != *$'\r'* && "$2" != *"'"* ]] || die "$1 contains a value unsupported by Compose .env quoting"
  printf "%s='%s'\n" "$1" "$2"
}

ask_yes "Install AI Workbench into $INSTALL_DIR?" yes || die "installation cancelled"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
command -v curl >/dev/null || die "curl is required to download the pinned release"
source_url="https://raw.githubusercontent.com/josephsandorvoros/ai-workbench/${WORKBENCH_SOURCE_REF}/deploy/docker-compose.yml"
curl -fsSL --retry 3 "$source_url" -o "$scratch/docker-compose.yml" || die "could not download Compose for $WORKBENCH_TAG"
grep -q '^name: spatial-workbench$' "$scratch/docker-compose.yml" || die "download did not contain the AI Workbench Compose file"

{
  env_line WORKBENCH_IMAGE_PREFIX 'ghcr.io/josephsandorvoros'
  env_line WORKBENCH_TAG "$WORKBENCH_TAG"
  env_line WORKBENCH_BIND '127.0.0.1'
  env_line WORKBENCH_PORT "$WORKBENCH_PORT"
  env_line WORKBENCH_AUTH 'token'
  env_line LLM_BASE_URL "$LLM_BASE_URL"
  env_line LLM_MODEL "$LLM_MODEL"
  env_line LLM_API_KEY "$LLM_API_KEY"
  env_line OPENCODE_MODEL "$OPENCODE_MODEL"
  env_line OPENCODE_CUSTOM_BASE_URL "$OPENCODE_CUSTOM_BASE_URL"
  env_line OPENCODE_CUSTOM_API_KEY "$OPENCODE_CUSTOM_API_KEY"
  env_line OPENCODE_MAIN_API_KEY "$OPENCODE_MAIN_API_KEY"
  env_line AGENT_SANDBOX "$AGENT_SANDBOX"
  env_line JOBS_SANDBOX "$JOBS_SANDBOX"
  env_line WORKER_MODEL "$WORKER_MODEL"
  env_line WORKER_BASE_URL "$WORKER_BASE_URL"
  env_line WORKER_API_KEY "$WORKER_API_KEY"
  env_line SANDBOX_ALLOW_LAN "$SANDBOX_ALLOW_LAN"
  env_line JOB_PLAN_APPROVAL '1'
  env_line JOB_AUTO_APPROVE '0'
} > "$scratch/.env"

install_docker
run_root install -d -m 0700 "$INSTALL_DIR"
run_root install -m 0644 "$scratch/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
run_root install -m 0600 "$scratch/.env" "$INSTALL_DIR/.env"
compose=(docker compose --project-directory "$INSTALL_DIR" --env-file "$INSTALL_DIR/.env" -f "$INSTALL_DIR/docker-compose.yml")
if [[ "$JOBS_SANDBOX" == 1 ]]; then
  jobs_compose="$INSTALL_DIR/docker-compose.jobs.yml"
  curl -fsSL --retry 3 "https://raw.githubusercontent.com/josephsandorvoros/ai-workbench/${WORKBENCH_SOURCE_REF}/deploy/docker-compose.jobs.yml" -o "$scratch/docker-compose.jobs.yml" || die "could not download Jobs sandbox Compose overlay from $WORKBENCH_SOURCE_REF"
  grep -q '^services:$' "$scratch/docker-compose.jobs.yml" || die "download did not contain the Jobs sandbox Compose overlay"
  run_root install -m 0644 "$scratch/docker-compose.jobs.yml" "$jobs_compose"
  compose+=(-f "$jobs_compose")
  compose+=(--profile sandbox)
fi
run_root "${compose[@]}" config --quiet || die "Compose validation failed; no containers started"
run_root "${compose[@]}" pull
run_root "${compose[@]}" up -d

ready=0
for attempt in {1..30}; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${WORKBENCH_PORT}/api/config" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 3
done
(( ready )) || die "containers started but health did not respond; inspect with: sudo docker compose -f $INSTALL_DIR/docker-compose.yml logs agent web"
printf '\nAI Workbench is ready. On your laptop run:\n  ssh -N -o ExitOnForwardFailure=yes -L 18420:127.0.0.1:%s %s\nEnter the VM account password or use your SSH key when prompted. Leave this terminal open; a successful tunnel stays connected without a shell prompt.\nThen open http://127.0.0.1:18420\n' \
  "$WORKBENCH_PORT" "$SSH_TARGET"