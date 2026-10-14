#!/usr/bin/env bash
# Usage: passkey-save.sh
# Writes .verify/auth/save-passkey.js: reads the virtual authenticator's credentials and posts them
# to a one-shot 127.0.0.1 receiver that writes .verify/auth/passkey.json (mode 600).
set -euo pipefail
source "$(dirname "$0")/common.sh"
mkdir -p "$REPO/.verify/auth"
P="$(oneshot receive "$REPO/.verify/auth/passkey.json")"
cat > "$REPO/.verify/auth/save-passkey.js" <<JS
async (page) => {
  if (!page._ppAuth) throw new Error('no virtual authenticator on this page; run attach-authenticator.js first');
  const { cdp, authenticatorId } = page._ppAuth;
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  await page.request.post('http://127.0.0.1:$P/', { data: JSON.stringify(credentials) });
  return { saved: credentials.length };
}
JS
echo ".verify/auth/save-passkey.js (run within 60s)"
