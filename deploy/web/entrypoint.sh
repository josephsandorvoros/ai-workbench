#!/bin/sh
# Derive Caddy upstreams from neutral env vars, then start Caddy.
set -eu

: "${WORKBENCH_PORT:=1420}"
: "${WORKBENCH_API_UPSTREAM:=agent:8080}"

# Split LLM_BASE_URL (e.g. http://10.0.0.5:8080/v1) into upstream + path prefix.
llm="${LLM_BASE_URL:-}"
if [ -n "$llm" ]; then
    llm="${llm%/}"
    scheme="${llm%%://*}"
    rest="${llm#*://}"
    hostport="${rest%%/*}"
    path=""
    [ "$rest" != "$hostport" ] && path="/${rest#*/}"
    LLM_UPSTREAM="${scheme}://${hostport}"
    LLM_PATH_PREFIX="$path"
else
    echo "[web] LLM_BASE_URL not set; /llm will return 502" >&2
    LLM_UPSTREAM="http://127.0.0.1:9"
    LLM_PATH_PREFIX=""
fi
export WORKBENCH_PORT WORKBENCH_API_UPSTREAM LLM_UPSTREAM LLM_PATH_PREFIX

# The model key is added here, never handed to the browser.
if [ -n "${LLM_API_KEY:-}" ]; then
    printf 'header_up Authorization "Bearer %s"\n' "$LLM_API_KEY" > /etc/caddy/llm-auth.caddy
else
    : > /etc/caddy/llm-auth.caddy
fi

# Optional client allowlist (CIDRs). Matches the direct peer, so list your reverse proxy's IP, not end users behind it.
allowed="$(printf '%s' "${WORKBENCH_ALLOWED_CLIENTS:-}" | tr ',' ' ' | xargs)"
if [ -n "$allowed" ]; then
    case "$allowed" in
        *[!0-9A-Fa-f:./\ ]*) echo "[web] WORKBENCH_ALLOWED_CLIENTS must be IPs/CIDRs separated by commas" >&2; exit 1 ;;
    esac
    # Loopback stays allowed for the container's own health check.
    printf '@blocked not remote_ip 127.0.0.1/32 ::1/128 %s\nrespond @blocked "Forbidden" 403\n' "$allowed" > /etc/caddy/allow.caddy
    echo "[web] allowing only: $allowed"
else
    : > /etc/caddy/allow.caddy
fi

# Optional HTTP basic auth in front of the whole UI.
if [ -n "${WORKBENCH_AUTH_USER:-}" ] && [ -n "${WORKBENCH_AUTH_PASSWORD_HASH:-}" ]; then
    printf 'basic_auth {\n\t%s %s\n}\n' "$WORKBENCH_AUTH_USER" "$WORKBENCH_AUTH_PASSWORD_HASH" > /etc/caddy/auth.caddy
    echo "[web] basic auth enabled for user $WORKBENCH_AUTH_USER"
else
    : > /etc/caddy/auth.caddy
    echo "[web] WARNING: no built-in auth; put this behind an authenticating proxy or set WORKBENCH_AUTH_USER/WORKBENCH_AUTH_PASSWORD_HASH" >&2
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
