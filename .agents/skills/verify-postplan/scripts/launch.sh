#!/usr/bin/env bash
# Usage: launch.sh <run-dir>
# Builds and (re)starts the compose stack, then waits for /readyz.
set -euo pipefail
source "$(dirname "$0")/common.sh"
RUN="${1:?usage: launch.sh <run-dir>}"

if [ -z "$(docker compose -f "$REPO/compose.yaml" ps -q --status running app 2>/dev/null)" ]; then
  touch "$RUN/started-stack"
fi
docker compose -f "$REPO/compose.yaml" up --build -d 2>&1 | tail -3

for _ in $(seq 1 60); do
  if curl -sf -m 2 "$BASE/readyz" >/dev/null; then
    echo "ready: $BASE"
    exit 0
  fi
  sleep 2
done
echo "FAIL: $BASE/readyz not ready after 120s" >&2
docker compose -f "$REPO/compose.yaml" logs --tail 40 app >&2
exit 1
