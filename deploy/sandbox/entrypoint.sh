#!/bin/sh
# Sandbox daemon for agent workers: Docker-in-Docker with TLS, LAN egress blocked
# inside this container's own network namespace (nothing is changed on the host).
set -eu

log() { echo "[sandbox] $*"; }

rule() {
    # Idempotent insert at the top of a chain.
    iptables -C "$@" 2>/dev/null || iptables -I "$@"
}

apply_rules() {
    iptables -N DOCKER-USER 2>/dev/null || true
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
        rule DOCKER-USER -d "$net" -j DROP
    done
    for net in $(printf '%s' "${SANDBOX_ALLOW_LAN:-}" | tr ',' ' '); do
        rule DOCKER-USER -d "$net" -j ACCEPT
    done
    # Replies to worker-initiated connections come back to private worker IPs; let them through.
    rule DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Workers may not open connections to this daemon itself (API port, anything else).
    for iface in docker0 br-+; do
        rule INPUT -i "$iface" -m conntrack --ctstate NEW -j DROP
    done
}

housekeeping() {
    until docker -H unix:///var/run/docker.sock info >/dev/null 2>&1; do sleep 1; done
    apply_rules
    log "daemon ready; LAN egress blocked${SANDBOX_ALLOW_LAN:+ (allowed: $SANDBOX_ALLOW_LAN)}"
    while true; do
        sleep 3600
        docker -H unix:///var/run/docker.sock system prune -af \
            --filter "until=${SANDBOX_PRUNE_HOURS:-24}h" >/dev/null 2>&1 || true
        apply_rules
    done
}

case "$(printf '%s' "${SANDBOX_ALLOW_LAN:-}" | tr -d ' ')" in
    *[!0-9A-Fa-f:./,]*) log "SANDBOX_ALLOW_LAN must be IPs/CIDRs separated by commas"; exit 1 ;;
esac

housekeeping &
exec dockerd-entrypoint.sh "$@"
