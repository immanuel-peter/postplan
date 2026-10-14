#!/usr/bin/env bash
# Usage: psql.sh "<sql>"   (read-only queries for evidence; prints unaligned rows)
set -euo pipefail
source "$(dirname "$0")/common.sh"
docker compose -f "$REPO/compose.yaml" exec -T postgres psql -U postplan -d postplan -P pager=off -c "$1"
