# Tokens

Bearer credentials (`pp_…`) for the API. Every token is a master key: no scopes or permission pickers in the UI (product rule). The secret is shown exactly once.

## Sub-features

- Generate in dashboard: `/keys` → **New key** panel (`h2#new-key-title`): `form.generate-form[action="/keys"]` with `#name`, submit "Generate a new API key" → `.secret-panel` shows the secret once in `code#new-secret` with `#copy-secret`. The note says "Keys are shown once." Errors are in `p.form-error`.
- List: **Keys** panel (`h2#keys-title`, `.panel-count`) with a `table.data-table` row per token: `.cell-title` name, `.cell-sub` prefix + `…`, created and last used. Secrets never show again on reload.
- Revoke in dashboard: `form[action="/keys/{id}/revoke"]` (`data-confirm-name`, `data-confirm-prefix`), button `aria-label="Revoke <name>"` → `<dialog id="revoke-dialog">` naming the key and prefix → `button[data-confirm]` "Revoke key" (`[data-cancel]` cancels). Falls back to `window.confirm` without `<dialog>` support. A revoked token gets 401 on the API.
- API: `GET /api/v1/tokens`, `POST /api/v1/tokens` (JSON `{"name": "..."}`, returns the secret once), `DELETE /api/v1/tokens/{id}` → 204, `GET /api/v1/me`

## How to get to it (user POV)

Dashboard nav **API keys** (`a[href="/keys"]`). Agents use the API with an existing token.

## Driving it with curl and Playwright

```bash
$S/req.sh "$RUN" 40-mint POST /api/v1/tokens -H 'Content-Type: application/json' -d '{"name":"verify-postplan"}'
```

`req.sh` redacts the secret on stdout. Load it into a variable without printing it: `T=$($S/field.sh "$RUN/40-mint.body" token)`. Then `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" http://postplan.localhost:3005/api/v1/me` → 200. Then revoke it inside the run, not via cleanup (cleanup may stop the stack): `$S/req.sh "$RUN" 41-revoke DELETE "/api/v1/tokens/$($S/field.sh "$RUN/40-mint.body" id)"` → 204, and the same `/me` curl → 401. Cleanup's later DELETE on that id returns 404, which is expected. Never echo `$T` or paste the secret into a report.

Dashboard: unlock → `/keys` → fill `#name` with `verify-postplan` → submit → screenshot `41-secret-once.png` (the `#new-secret` block visible) → `browser_navigate` `/keys` again → screenshot `42-reload.png` (no secret) → click `button[aria-label="Revoke verify-postplan"]` → screenshot the open `#revoke-dialog` → click `#revoke-dialog button[data-confirm]` → screenshot `43-revoked.png` (row gone). Append `token\t<id>` to `created.tsv` if you didn't revoke it in the UI.

## Gotchas

- Never revoke the bootstrap token (name `bootstrap`). Every helper depends on it.
- Screenshots of `41-secret-once.png` contain a live secret for the local stack only. Revoke it before the run ends.
