#!/usr/bin/env python3
"""Remove Hermes worker containers left over from before this agent started.

Hermes reattaches to labeled workers across restarts, and a reattached worker keeps
the mounts it was created with, so stale workers would ignore config changes.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

BOOT = time.time()
WAIT_SECONDS = int(os.environ.get("SANDBOX_REAPER_WAIT", "180"))


def log(msg):
    print(f"[sandbox-reaper] {msg}", flush=True)


def docker(*args, timeout=30):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def created_ts(value):
    # Docker reports RFC 3339 with nanoseconds; trim to microseconds for fromisoformat.
    stamp = re.sub(r"(\.\d{6})\d+", r"\1", value.strip()).replace("Z", "+00:00")
    return datetime.fromisoformat(stamp).timestamp()


def main():
    deadline = BOOT + WAIT_SECONDS
    while True:
        try:
            if docker("info", timeout=10).returncode == 0:
                break
        except (OSError, subprocess.TimeoutExpired):
            pass
        if time.time() > deadline:
            log("sandbox daemon not reachable; skipping cleanup")
            return
        time.sleep(3)

    ids = docker("ps", "-aq", "--filter", "label=hermes-task-id").stdout.split()
    if not ids:
        log("no leftover workers")
        return
    stale = []
    for info in json.loads(docker("inspect", *ids).stdout or "[]"):
        try:
            if created_ts(info["Created"]) < BOOT:
                stale.append(info["Id"][:12])
        except (KeyError, ValueError):
            continue
    if stale:
        result = docker("rm", "-f", *stale, timeout=120)
        log(f"removed {len(stale)} leftover worker(s): {' '.join(stale)}" if result.returncode == 0
            else f"cleanup failed: {result.stderr.strip()[:200]}")
    else:
        log("no leftover workers")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # never crash-loop the service over cleanup
        log(f"cleanup error: {exc}")
    sys.exit(0)
