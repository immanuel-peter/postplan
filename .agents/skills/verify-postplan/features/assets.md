# Assets

Immutable binary blobs (images, video, PDFs, SVG, JSON) with a stable public URL on `assets.postplan.localhost:3005`, used by Drafts as embeds. Bytes never change. `description` (alt-text) is the one mutable field.

## Sub-features

- Upload via API: `POST /api/v1/assets` (multipart `file`, optional `description`) → 201 with `id`, `url`, `contentType`, `byteSize`, `filename`, `description`
- Upload via dashboard: `/assets` drop bar (`section#dropzone`, `aria-label="Upload"`), "Browse files" `#browse-files` opens the hidden `#file-input` (multiple). The page `fetch`es `POST /assets` with `_csrf` in the multipart body, then reloads. Errors show in `#assets-error` (`role="alert"`).
- Dashboard list: `h2#all-assets`, `table.assets-table`, one row per Asset with `a.thumb-sm` and `a.asset-filename` → `/assets/{id}`
- Serve: `http://assets.postplan.localhost:3005/{id}[.ext]` with the stored content type, `ETag`, 304 on `If-None-Match`, `Range` requests (206)
- Read/list: `GET /api/v1/assets`, `GET /api/v1/assets/{id}`
- Description via API: `PATCH /api/v1/assets/{id}` (JSON `{"description": "..."}`)
- Description in place on `/assets/{id}`: click `button#desc-display` ("Edit description"), type into `input#description` (counter `#desc-count` "/ 125", max 2000), press Enter to save or Escape to cancel; blur also saves. It saves via `fetch` POST to `form#desc-form`'s action without a page load. `#desc-status` shows "Saved" or the error, and `#desc-text`, the preview `alt`, and the Markdown/HTML snippets update live.
- Detail page: `h1.asset-title` (filename), Open button, `a#asset-url` + `button[data-copy="asset-url"]`, `img#asset-preview` for images, **Reference** section (`h2#reference-title`) with `code.ref-value[data-snippet="markdown"|"html"|…]` and `button[data-copy]` copy buttons, **Details** table (`table.details-table`)
- Delete via API: `DELETE /api/v1/assets/{id}` → 204
- Delete in dashboard: `form#delete-form` → `<dialog id="delete-dialog">` → `button[data-confirm]` ("Delete asset"; `[data-cancel]` cancels) → redirect `/assets?deleted=1` with flash `p.flash` "Asset deleted." Afterwards the public URL → 404.

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

Dashboard (after unlocking per SKILL.md):

1. `browser_navigate` `/assets` → screenshot `25-assets.png`.
2. Click `#browse-files`, then `browser_file_upload` with `$RUN/dot.svg` → the page reloads and a `dot.svg` row appears in `table.assets-table` → screenshot `26-uploaded.png`.
3. Click its `a.asset-filename` → detail page. The id is the last path segment of the URL. Append `asset\t<id>` to `created.tsv`.
4. Click `#desc-display`, type into `#description`, press Enter → `#desc-status` reads "Saved" and `code[data-snippet="markdown"]` contains the new alt text → screenshot `27-described.png`. Confirm with `$S/req.sh "$RUN" 28-after-describe GET /api/v1/assets/<id>`.
5. To check delete: click `#delete-form button[type="submit"]`, screenshot the open `#delete-dialog`, click `button[data-confirm]` → `/assets?deleted=1` with the flash → screenshot. The asset URL → 404. Remove that id from `created.tsv`, or let cleanup's DELETE return 404.

## Gotchas

- `url` in the API response is the asset host URL with extension. The bare `/{id}` works too.
- SVGs are served with a sandboxing CSP (`ASSET_DOCUMENT_CSP`). Check that header when `src/lib/csp.ts` changes.
- The upload posts `_csrf` inside its multipart body. That is the one path `admin-guard.ts` exempts from the normal CSRF hook. Changes to `src/lib/admin-guard.ts` or `src/lib/multipart.ts` need the dashboard upload driven, not just the API.
