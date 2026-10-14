# Tokens

Bearer credentials (`pp_…`) for the API. Every token is a master key: no scopes or permission pickers in the UI (product rule). The secret is shown exactly once.

## Sub-features

- Generate in dashboard: `/keys` → `form.generate-form[action="/keys"]` with `#name` → the page shows the secret once in `code#new-secret` with `#copy-secret`
- List: `/keys` table with name/prefix/last used. Secrets never shown again on reload.
- Revoke in dashboard: `form[action="/keys/{id}/revoke"]` → revoked token gets 401 on the API
- API: `GET /api/v1/tokens`, `POST /api/v1/tokens` (JSON `{"name": "..."}`, returns the secret once), `DELETE /api/v1/tokens/{id}` → 204, `GET /api/v1/me`

## How to get to it (user POV)

Dashboard nav **API keys** (`a[href="/keys"]`). Agents use the API with an existing token.

## Driving it with curl and Playwright

```bash
$S/req.sh "$RUN" 40-mint POST /api/v1/tokens -H 'Content-Type: application/json' -d '{"name":"verify-postplan"}'
```

Read the new secret from `40-mint.body`. Then `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <secret>" http://postplan.localhost:3005/api/v1/me` → 200. Cleanup revokes it. Rerun the same curl after `cleanup.sh` → 401 and note it in the report. Never paste the secret into a report.

Dashboard: unlock → `/keys` → fill `#name` → submit → screenshot `41-secret-once.png` (the `#new-secret` block visible) → `browser_navigate` `/keys` again → screenshot `42-reload.png` (no secret) → submit that row's revoke form → screenshot `43-revoked.png`. Append `token\t<id>` to `created.tsv` if you didn't revoke it in the UI.

## Gotchas

- Never revoke the bootstrap token (name `bootstrap`). Every helper depends on it.
- Screenshots of `41-secret-once.png` contain a live secret for the local stack only. Revoke it before the run ends.
