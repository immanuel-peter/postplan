#!/usr/bin/env bash
# Usage: scope.sh [base-ref]   (default: main)
# Maps files changed since the merge-base (plus uncommitted/untracked) to feature files to verify.
set -euo pipefail
source "$(dirname "$0")/common.sh"
cd "$REPO"
BASE_REF="${1:-main}"
FILES=$( { git diff --name-only "$(git merge-base "$BASE_REF" HEAD)"; git status --porcelain | cut -c4-; } | sort -u)
[ -z "$FILES" ] && { echo "no changes vs $BASE_REF"; exit 0; }

OUT=""
add() { OUT="$OUT$1"$'\n'; }
while read -r f; do
  case "$f" in
    src/routes/api.ts) add publish-and-versions; add assets; add tokens ;;
    src/services/drafts.ts|src/lib/multipart.ts|src/lib/slug.ts|src/lib/tokens.ts|src/lib/auth.ts) add publish-and-versions ;;
    src/routes/public.ts|src/lib/csp.ts|src/lib/host.ts|src/lib/html.ts) add public-draft-serving ;;
    src/routes/assets-public.ts|src/services/assets.ts|src/services/orphans.ts|src/lib/s3.ts) add assets ;;
    src/views/assets/*) add assets ;;
    src/services/tokens.ts|src/views/tokens/*) add tokens ;;
    src/routes/dashboard.ts|src/views/drafts/*|src/views/layouts/main.eta|src/public/app.css) add dashboard-drafts ;;
    src/routes/auth.ts|src/lib/admin-*|src/services/admin.ts|src/public/webauthn.js|src/views/auth/*|src/views/layouts/auth.eta) add passkey-auth ;;
    drizzle/*|src/db/*) add "migrations (doctor) + every feature touching the changed tables" ;;
    compose.yaml|Dockerfile|src/config.ts|src/server.ts|src/app.ts|package*.json) add "launch + doctor, then publish-and-versions as a smoke" ;;
  esac
done <<< "$FILES"

echo "changed files:"; sed 's/^/  /' <<< "$FILES"
echo "verify (features/<name>.md):"
printf "%s" "$OUT" | sort -u | sed '/^$/d; s/^/  /'
