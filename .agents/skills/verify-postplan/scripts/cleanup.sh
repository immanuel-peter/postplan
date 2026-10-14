#!/usr/bin/env bash
# Usage: cleanup.sh <run-dir>
# Deletes what the run created (created.tsv) via the API and closes out the run.
# Stops the stack only if launch.sh started it. Never removes volumes or the run dir.
set -uo pipefail
source "$(dirname "$0")/common.sh"
RUN="${1:?usage: cleanup.sh <run-dir>}"

while IFS=$'\t' read -r KIND ID; do
  [ -z "$KIND" ] && continue
  case "$KIND" in
    draft) P="/api/v1/drafts/$ID" ;;
    asset) P="/api/v1/assets/$ID" ;;
    token) P="/api/v1/tokens/$ID" ;;
    *) echo "skip unknown kind $KIND"; continue ;;
  esac
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE$P")
  echo "DELETE $P -> $CODE" | tee -a "$RUN/cleanup.log"
done < "$RUN/created.tsv"

# Generated one-shot snippets are scratch; passkey.json is kept for the next run.
rm -f "$REPO"/.verify/auth/{fill-secret,save-passkey,restore-passkey}.js

if [ -f "$RUN/started-stack" ]; then
  docker compose -f "$REPO/compose.yaml" stop | tee -a "$RUN/cleanup.log"
fi
echo "finished: $(date -u +%FT%TZ)" >> "$RUN/meta.txt"
echo "evidence kept at $RUN"
