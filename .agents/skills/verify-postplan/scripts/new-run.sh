#!/usr/bin/env bash
# Usage: new-run.sh <label>
# Creates .verify/runs/<utc-stamp>-<label>/ and prints its path.
set -euo pipefail
source "$(dirname "$0")/common.sh"
LABEL="${1:?usage: new-run.sh <label>}"
RUN="$REPO/.verify/runs/$(date -u +%Y%m%dT%H%M%SZ)-$LABEL"
mkdir -p "$RUN"
{
  echo "label: $LABEL"
  echo "started: $(date -u +%FT%TZ)"
  echo "branch: $(git -C "$REPO" branch --show-current)"
  echo "head: $(git -C "$REPO" rev-parse --short HEAD)"
  echo "dirty: $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') files"
} > "$RUN/meta.txt"
: > "$RUN/created.tsv"
echo "$RUN"
