#!/usr/bin/env bash
# Usage: secret-fill.sh setup|recovery
# Writes .verify/auth/fill-secret.js: fetches the .env secret from a one-shot 127.0.0.1 server,
# fills #secret on /setup, and submits. The secret never appears in the snippet or tool output.
set -euo pipefail
source "$(dirname "$0")/common.sh"
case "${1:-}" in
  setup) KEY=ADMIN_SETUP_SECRET ;;
  recovery) KEY=ADMIN_RECOVERY_SECRET ;;
  *) echo "usage: secret-fill.sh setup|recovery" >&2; exit 1 ;;
esac
VALUE="$(envval "$KEY")"
[ -n "$VALUE" ] || { echo "$KEY is empty in .env" >&2; exit 1; }
mkdir -p "$REPO/.verify/auth"
export "$KEY=$VALUE"
P="$(oneshot serve-env "$KEY")"
cat > "$REPO/.verify/auth/fill-secret.js" <<JS
async (page) => {
  const secret = await (await page.request.get('http://127.0.0.1:$P/')).text();
  await page.locator('#secret').fill(secret);
  await page.locator('form[action="/setup"] button[type=submit]').click();
  await page.waitForLoadState('load');
  return { url: page.url(), title: await page.title() };
}
JS
echo ".verify/auth/fill-secret.js (run within 60s)"
