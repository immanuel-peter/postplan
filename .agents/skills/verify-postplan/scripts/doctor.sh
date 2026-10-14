#!/usr/bin/env bash
# Usage: doctor.sh   (read-only; exit 1 if the instance is not worth driving)
set -uo pipefail
source "$(dirname "$0")/common.sh"
FAILS=0
ok() { echo "ok    $*"; }
warn() { echo "WARN  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }

STATE=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' postplan-app 2>/dev/null)
case "$STATE" in
  "running healthy") ok "postplan-app running, healthy" ;;
  running*) warn "postplan-app $STATE" ;;
  *) fail "postplan-app not running (${STATE:-missing}); run launch.sh"; echo "$FAILS check(s) failed"; exit 1 ;;
esac

DIR=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' postplan-app)
[ "$DIR" = "$REPO" ] && ok "stack belongs to this checkout" || fail "stack was started from $DIR, not $REPO"

APP_PORT=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' postplan-app | sed -n 's/^PORT=//p')
[ "$APP_PORT" = "$PORT" ] && ok "app PORT=$APP_PORT" || fail "app PORT=$APP_PORT but skill expects $PORT (origin checks need them equal)"

READY=$(curl -s -m 3 "$BASE/readyz")
case "$READY" in *'"ok":true'*) ok "readyz: $READY" ;; *) fail "readyz: ${READY:-no response}" ;; esac

WANT=$(grep -c '"tag"' "$REPO/drizzle/meta/_journal.json")
HAVE=$("$(dirname "$0")/psql.sh" "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null | sed -n '3p' | tr -d ' ')
[ "$HAVE" = "$WANT" ] && ok "migrations applied: $HAVE/$WANT" || fail "migrations applied: ${HAVE:-?}/$WANT"

# Compose recreates the container whenever the image changes, so its creation time bounds the build.
BUILT_TS=$(node -e 'console.log(Math.floor(Date.parse(process.argv[1])/1000))' \
  "$(docker inspect -f '{{.Created}}' postplan-app)")
NEWEST=$(cd "$REPO" && find src drizzle package.json package-lock.json tsconfig.json Dockerfile -type f -exec stat -f '%m %N' {} + | sort -n | tail -1)
if [ "${NEWEST%% *}" -gt "$BUILT_TS" ]; then
  warn "container older than ${NEWEST#* }; run launch.sh; if it does not recreate postplan-app, the content is unchanged and this is safe"
else
  ok "container newer than every source file"
fi

ME=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/me")
[ "$ME" = 200 ] && ok "bootstrap token accepted by /api/v1/me" || fail "/api/v1/me returned $ME with BOOTSTRAP_TOKEN from .env"

CREDS=$("$(dirname "$0")/psql.sh" "select count(*) from admin_credentials" 2>/dev/null | sed -n '3p' | tr -d ' ')
SETUP=$(curl -s -m 3 -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/setup")
SETUP_BODY=$(curl -s -m 3 "$BASE/setup")
case "$SETUP_BODY" in
  *"Recover access"*) MODE="recovery secret unused (available)" ;;
  *"Set up PostPlan"*) MODE="first-run setup open" ;;
  *) MODE="no setup/recovery available ($SETUP); rotate ADMIN_RECOVERY_SECRET to re-enroll" ;;
esac
if [ -f "$REPO/.verify/auth/passkey.json" ]; then
  ok "dashboard: $CREDS passkey(s) enrolled; saved agent passkey present; $MODE"
else
  warn "dashboard: $CREDS passkey(s) enrolled; no saved agent passkey; $MODE"
fi

[ "$FAILS" -eq 0 ] && echo "doctor: instance is drivable" || { echo "doctor: $FAILS check(s) failed"; exit 1; }
