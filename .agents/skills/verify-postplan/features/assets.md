# Assets

Immutable binary blobs (images, video, PDFs, SVG, JSON) with a stable public URL on `assets.postplan.localhost:3005`, used by Drafts as embeds. Bytes never change. `description` (alt-text) is the one mutable field.

## Sub-features

- Upload via API: `POST /api/v1/assets` (multipart `file`, optional `description`) → 201 with `id`, `url`, `contentType`, `byteSize`, `filename`, `description`
- Upload via dashboard: `/assets` dropzone (`#dropzone`, hidden `#file-input`, multiple files), errors in `#assets-error`
- Serve: `http://assets.postplan.localhost:3005/{id}[.ext]` with the stored content type, `ETag`, 304 on `If-None-Match`, `Range` requests (206)
- Read/list: `GET /api/v1/assets`, `GET /api/v1/assets/{id}`
- Description: `PATCH /api/v1/assets/{id}` (JSON `{"description": "..."}`), or dashboard `/assets/{id}` form `form[action="/assets/{id}"]` with `textarea#description` (max 2000)
- Embed snippets on `/assets/{id}`: `.embed-row code.embed-value`, copy buttons `button[data-copy]`; snippets use the description as alt text
- Delete: `DELETE /api/v1/assets/{id}` → 204, or dashboard `form[action="/assets/{id}/delete"]` (confirm dialog); afterwards the public URL → 404

## How to get to it (user POV)

Agents upload with a token (the `asset-upload` skill in `skills/`). The owner opens the dashboard's **Assets** nav (`a[href="/assets"]`), drops files, opens one for its URL and embed snippets, and edits the description.

## Driving it with curl and Playwright

```bash
printf '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c33"/></svg>' > "$RUN/dot.svg"
$S/req.sh "$RUN" 20-upload POST /api/v1/assets -F "file=@$RUN/dot.svg;type=image/svg+xml" -F "description=red square"
AID=$($S/field.sh "$RUN/20-upload.body" id)
AURL=$($S/field.sh "$RUN/20-upload.body" url)
$S/req.sh "$RUN" 21-public GET "$AURL"
$S/req.sh "$RUN" 22-range GET "$AURL" -H 'Range: bytes=0-9'
$S/req.sh "$RUN" 23-describe PATCH "/api/v1/assets/$AID" -H 'Content-Type: application/json' -d '{"description":"red square, edited"}'
$S/psql.sh "select id, description, byte_size from assets where id='$AID'" > "$RUN/24-asset-row.sql.txt"
```

Pass when: 21 is 200 with the SVG bytes and an `image/svg+xml` type; 22 is 206; 23 echoes the new description, and so does 24.

Dashboard (after unlocking per SKILL.md): `browser_navigate` `/assets` → screenshot → `browser_file_upload` on `#file-input` with `$RUN/dot.svg` → the new row appears → open it → screenshot embed rows → edit `#description`, submit → screenshot showing the new description in the `.lede` and the embed snippet. The id is the last path segment of the detail URL. Append `asset\t<id>` to `created.tsv`.

## Gotchas

- `url` in the API response is the asset host URL with extension. The bare `/{id}` works too.
- SVGs are served with a sandboxing CSP (`ASSET_DOCUMENT_CSP`). Check that header when `src/lib/csp.ts` changes.
- The dropzone posts `_csrf` inside its multipart body. That is the one path `admin-guard.ts` exempts from the normal CSRF hook. Changes to `src/lib/admin-guard.ts` or `src/lib/multipart.ts` need the dashboard upload driven, not just the API.
