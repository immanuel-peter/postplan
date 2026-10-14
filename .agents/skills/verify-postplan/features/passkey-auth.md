# Passkey auth (dashboard gate)

One passkey identity guards the dashboard (ADR 0008). No email, password, or signup. Drafts and Assets stay public. Only the apex dashboard is locked.

## Sub-features

- First-run setup: `/setup` with `ADMIN_SETUP_SECRET` → enroll page (`#device`, `#enroll`) → `/`
- Recovery: `/setup` in "Recover access" mode with `ADMIN_RECOVERY_SECRET`. Wipes all passkeys and sessions, single use per secret. Once spent, `/setup` redirects to `/unlock`.
- Unlock: `/unlock` (`h1.unlock-title` "Welcome!") → `#unlock` ("Unlock with passkey") → WebAuthn assertion → redirect to `next` or `/`; failure shows `#unlock-error` and relabels the button "Try again"
- Recovery link on the unlock page (`a[href="/setup"]`, "Use your recovery secret") only while recovery is available
- Lock: nav `form[action="/lock"] button` → back to `/unlock`
- Security page `/security`:
  - **Passkeys** (`h2#passkeys-title`): add with `button#add-passkey` (register_add flow, errors in `#passkey-error`); remove with `form[action="/security/passkeys/{id}/delete"]`, button `aria-label="Remove <name>"`
  - **Sessions** (`h2#sessions-title`): revoke one with `form[action="/security/sessions/{id}/revoke"]`, button `aria-label="Revoke <label>"` (revoking your own session redirects to `/unlock`); revoke all with `form[action="/security/sessions/revoke-all"]`
- Guarding: dashboard routes redirect to `/unlock?next=…` without a session; mutations need `_csrf` + exact `Origin` (403 `bad csrf` / `bad origin` otherwise)

## How to get to it (user POV)

Visit `http://postplan.localhost:3005/` with no session → unlock gate → Touch ID.

## Driving it with Playwright

The virtual authenticator from SKILL.md stands in for Touch ID. Unlock and lock without touching enrollments:

1. `browser_navigate` `/keys` (logged out) → screenshot `50-gate.png`. URL is `/unlock?next=%2Fkeys`.
2. Restore the agent passkey, click `#unlock` → lands on `/keys` (proves `next`). Screenshot `51-unlocked.png`.
3. Click the lock button → `/unlock`. Screenshot `52-locked.png`.
4. Guard checks from curl, logged out: `$S/req.sh "$RUN" 53-guard GET /` → 302/303 to `/unlock`; `$S/req.sh "$RUN" 54-bad-origin POST /lock -H 'Origin: http://evil.localhost:3005'` → 403.
5. `/security` flows (add/remove passkey, revoke one or all sessions) change real enrollment state. Drive them only when the diff touches them. Removing the agent passkey, or revoking every session, means re-enrolling through recovery afterwards (SKILL.md), so do it last and refresh `.verify/auth/passkey.json`. To test add/remove without losing access, add a second virtual credential named `verify-postplan agent 2` and remove that one.

Setup and recovery themselves are exercised by SKILL.md's enrollment steps, under the same rules: setup when it's open, recovery when every enrolled passkey is an agent's, and ask first when a human's passkey is enrolled. A fresh-DB setup test needs `docker compose down -v`, which wipes all local data and the agent passkey. Ask the user before doing that.

## Gotchas

- An agent passkey restore bumps the sign count to wall-clock seconds, because the server rejects non-increasing counters. A raw re-import of an old export fails unlock.
- `/setup` POST is rate-limited. Repeated wrong secrets lock it out for a while.
- `postplan.localhost` is the WebAuthn RP ID. `localhost:3005` and `127.0.0.1:3005` pass the origin check but are a different RP, so passkeys don't work there.
