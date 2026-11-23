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
    src/routes/public.ts|src/lib/csp.ts|src/lib/host.ts|src/lib/html.ts|src/lib/link-preview.ts|src/lib/og-card.ts) add public-draft-serving ;;
    src/routes/assets-public.ts|src/services/assets.ts|src/services/orphans.ts|src/lib/s3.ts|src/lib/thumbnails.ts|src/public/*-asset.*) add assets ;;
    src/lib/search.ts) add publish-and-versions; add assets ;;
    src/public/table-search.js) add dashboard-drafts; add assets ;;
    src/views/assets/*) add assets ;;
    src/services/tokens.ts|src/views/settings/keys.eta) add tokens ;;
    src/routes/dashboard.ts|src/views/drafts/*|src/views/layouts/main.eta|src/views/layouts/settings.eta|src/views/settings/appearance.eta|src/lib/theme.ts|src/public/app.css|src/public/localtime.js|src/lib/time.ts|src/public/sw.js|src/public/manifest.webmanifest|src/public/offline.html) add dashboard-drafts ;;
    src/lib/request.ts) add publish-and-versions; add public-draft-serving; add assets; add "the dashboard feature whose handler uses the changed helper" ;;
    test/*|tsconfig.test.json|.github/*) add "none (npm run typecheck + npm test cover it)" ;;
    src/routes/auth.ts|src/lib/admin-*|src/services/admin.ts|src/public/webauthn.js|src/views/auth/*|src/views/settings/security.eta|src/views/layouts/auth.eta) add passkey-auth ;;
    drizzle/*|src/db/*) add "migrations (doctor) + every feature touching the changed tables" ;;
    compose.yaml|Dockerfile|src/config.ts|src/server.ts|src/app.ts|package*.json) add "launch + doctor, then publish-and-versions as a smoke" ;;
  esac
done <<< "$FILES"

echo "changed files:"; sed 's/^/  /' <<< "$FILES"
echo "verify (features/<name>.md):"
printf "%s" "$OUT" | sort -u | sed '/^$/d; s/^/  /'
