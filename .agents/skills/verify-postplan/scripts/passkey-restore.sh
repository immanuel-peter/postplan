#!/usr/bin/env bash
# Usage: passkey-restore.sh
# Writes .verify/auth/restore-passkey.js: fetches .verify/auth/passkey.json from a one-shot
# 127.0.0.1 server and adds it to a virtual authenticator on the current page.
set -euo pipefail
source "$(dirname "$0")/common.sh"
SAVED="$REPO/.verify/auth/passkey.json"
[ -f "$SAVED" ] || { echo "no $SAVED; enroll first (SKILL.md, Dashboard)" >&2; exit 1; }
P="$(oneshot serve-file "$SAVED")"
cat > "$REPO/.verify/auth/restore-passkey.js" <<JS
async (page) => {
  const credentials = await (await page.request.get('http://127.0.0.1:$P/')).json();
  if (!page._ppAuth) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    page._ppAuth = { cdp, authenticatorId };
  }
  const { cdp, authenticatorId } = page._ppAuth;
  for (const credential of credentials) {
    // The server rejects non-increasing sign counts; wall-clock seconds always move forward.
    credential.signCount = Math.max(credential.signCount, Math.floor(Date.now() / 1000));
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  return { authenticatorId, restored: credentials.length };
}
JS
echo ".verify/auth/restore-passkey.js (run within 60s)"
