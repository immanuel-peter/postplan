#!/usr/bin/env bash
# Usage: req.sh <run-dir> <name> <METHOD> <path-or-url> [extra curl args...]
# Paths starting with /api get the dashboard base URL and the bootstrap bearer token.
# Saves <name>.headers and <name>.body in the run dir, prints status, key headers, and body.
# A 201 from POST /api/v1/{drafts,assets,tokens} is recorded in created.tsv for cleanup.
set -euo pipefail
source "$(dirname "$0")/common.sh"
RUN="$1"; NAME="$2"; METHOD="$3"; TARGET="$4"; shift 4

AUTH=()
case "$TARGET" in
  /api/*) URL="$BASE$TARGET"; AUTH=(-H "Authorization: Bearer $TOKEN") ;;
  /*) URL="$BASE$TARGET" ;;
  *) URL="$TARGET" ;;
esac

echo "$METHOD $URL $*" > "$RUN/$NAME.req"
STATUS=$(curl -sS -X "$METHOD" "${AUTH[@]+"${AUTH[@]}"}" -D "$RUN/$NAME.headers" -o "$RUN/$NAME.body" -w '%{http_code}' "$URL" "$@")

if [ "$METHOD" = POST ] && [ "$STATUS" = 201 ]; then
  case "$TARGET" in
    /api/v1/drafts) KIND=draft ;;
    /api/v1/assets) KIND=asset ;;
    /api/v1/tokens) KIND=token ;;
    *) KIND= ;;
  esac
  if [ -n "$KIND" ]; then
    ID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id)' "$RUN/$NAME.body")
    printf '%s\t%s\n' "$KIND" "$ID" >> "$RUN/created.tsv"
  fi
fi

echo "HTTP $STATUS  $METHOD $URL"
grep -iE '^(content-type|content-security-policy|etag|location|cache-control):' "$RUN/$NAME.headers" || true
head -c 1500 "$RUN/$NAME.body"; echo
