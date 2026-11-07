# Assets

Immutable binary blobs (images, video, PDFs, SVG, JSON) with a stable public URL on `assets.postplan.localhost:3005`, used by Drafts as embeds. Bytes never change. `description` (alt-text) is the one mutable field.

## Sub-features

- Upload via API: `POST /api/v1/assets` (multipart `file`, optional `description`) → 201 with `id`, `url`, `contentType`, `byteSize`, `filename`, `description`
- Upload via dashboard: `/assets` drop bar (`section#dropzone`, `aria-label="Upload"`, "Drop or paste files here"), "Browse files" `#browse-files` opens the hidden `#file-input` (multiple). The page `fetch`es `POST /assets` with `_csrf` in the multipart body, then reloads. Errors show in `#assets-error` (`role="alert"`).
- Paste upload: pasting files anywhere on `/assets` (not into an input, textarea, select, or contenteditable) uploads them the same way. Clipboard images with no real name (`image.png`) are renamed `pasted-YYYY-MM-DD-HHMMSS.{ext}`, with `-1`, `-2`… when several are pasted at once.
- Dashboard list: `h2#all-assets`, `table#assets-table.assets-table`, one row per Asset with `a.thumb-sm` and `a.asset-filename` → `/assets/{id}`. `a.thumb-sm` gets `background-color` from the stored dominant colour and an `img` from `/thumbs/{id}.webp` when a thumbnail exists; images without one fall back to the full asset URL; videos without one show only `.play-overlay`; everything else shows a `.thumb-icon`.
- Live search on the list: `input[data-table-search="assets-table"]` ("Search assets…", only when there are Assets) hides rows client-side. Every word must appear in the filename, `.cell-sub` (description), or `.ext-tag`. No match shows `tr.search-empty` "No assets match your search."; Escape clears.
- Thumbnails: on upload, raster images (png, jpeg, gif, webp, avif, tiff) and `video/*` (one frame via ffmpeg in the app image) get a 104×78 WebP at `thumbs/{id}.webp` in Garage, plus `thumb_color`. Served at `http://assets.postplan.localhost:3005/thumbs/{id}.webp` with `image/webp`, `ETag: "thumb-{sha256}"` (304 on match), immutable cache. SVG, PDF and other types get none (404). A file that can't be previewed gets `thumb_failed_at`. On boot the app backfills thumbnails for Assets with neither `thumb_key` nor `thumb_failed_at` (log line `thumbnail backfill done`).
- Serve: `http://assets.postplan.localhost:3005/{id}[.ext]` with the stored content type, `ETag`, 304 on `If-None-Match`, `Range` requests (206)
- Read/list: `GET /api/v1/assets`, `GET /api/v1/assets/{id}`. `?q=` searches like Drafts: every whitespace-separated word must appear in `filename` or `description`, case-insensitive, `%` `_` `\` literal.
- Description via API: `PATCH /api/v1/assets/{id}` (JSON `{"description": "..."}`)
- Description in place on `/assets/{id}`: click `button#desc-display` ("Edit description"), type into `input#description` (counter `#desc-count` "/ 125", max 2000), press Enter to save or Escape to cancel; blur also saves. It saves via `fetch` POST to `form#desc-form`'s action without a page load. `#desc-status` shows "Saved" or the error, and `#desc-text`, the preview `alt`, and the Markdown/HTML snippets update live.
- Detail page: `h1.asset-title` (filename), Download button (`.page-actions a[download]` → `{asset url}?download=1`, served `Content-Disposition: attachment`), Open button, `a#asset-url` + `button[data-copy="asset-url"]`, `img#asset-preview` for images, **Reference** section (`h2#reference-title`) with `code.ref-value[data-snippet="markdown"|"html"|…]` and `button[data-copy]` copy buttons, **Details** table (`table.details-table`)
- Step between assets on `/assets/{id}`: with two or more Assets, `nav#asset-pager` sits on the back-link row (`.crumb-row`) with `a#pager-prev[rel="prev"]` (the row above in the list, uploaded after this one), `a#pager-next[rel="next"]` (the row below), and `.pager-count` ("3 of 11"). At either end that arrow is a `span#pager-prev-end` / `#pager-next-end` with no link. ← and → follow the links with `location.replace`, so `history.length` does not grow and Back goes straight to `/assets`. Keys are ignored with Alt/Ctrl/Meta/Shift, while `input#description` has focus, while a `<video>` or `<audio>` has focus (Esc blurs it), and while `#delete-dialog` is open. At an end the key does nothing: `#pager-status` reads "This is the first asset" or "This is the last asset" and the end arrow gets `.is-bump`. `#pager-hint` ("← → to browse") shows until the first arrow press (`localStorage` key `postplan.assetKeysUsed`).
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

Thumbnails and search (ffmpeg is installed on the host):

```bash
ffmpeg -v error -y -f lavfi -i color=c=0x2266cc:s=320x240 -frames:v 1 "$RUN/blue.png"
ffmpeg -v error -y -f lavfi -i color=c=0x22aa44:s=320x240:d=1 -pix_fmt yuv420p "$RUN/clip.mp4"
$S/req.sh "$RUN" 20b-png POST /api/v1/assets -F "file=@$RUN/blue.png;type=image/png" -F "description=quokka blue"
$S/req.sh "$RUN" 20c-mp4 POST /api/v1/assets -F "file=@$RUN/clip.mp4;type=video/mp4" -F "description=quokka green clip"
PID=$($S/field.sh "$RUN/20b-png.body" id); MID=$($S/field.sh "$RUN/20c-mp4.body" id)
$S/req.sh "$RUN" 25-thumb-png GET "http://assets.postplan.localhost:3005/thumbs/$PID.webp"
$S/req.sh "$RUN" 25b-thumb-304 GET "http://assets.postplan.localhost:3005/thumbs/$PID.webp" -H "If-None-Match: \"thumb-$($S/field.sh "$RUN/20b-png.body" sha256)\""
$S/req.sh "$RUN" 25c-thumb-mp4 GET "http://assets.postplan.localhost:3005/thumbs/$MID.webp"
$S/req.sh "$RUN" 25d-thumb-svg GET "http://assets.postplan.localhost:3005/thumbs/$AID.webp"
$S/req.sh "$RUN" 26-search GET "/api/v1/assets?q=quokka%20CLIP"
$S/psql.sh "select id, content_type, thumb_key, thumb_color, thumb_failed_at from assets where id in ('$AID','$PID','$MID')" > "$RUN/27-thumb-rows.sql.txt"
```

Pass when: 21 is 200 with the SVG bytes and an `image/svg+xml` type; 22 is 206; 23 echoes the new description, and so does 24; 25 and 25c are 200 `image/webp`, 25b is 304, 25d is 404; 26 lists only `clip.mp4`; 27 shows `thumb_key` and a `#rrggbb` colour for the png and mp4 and nulls for the svg. The API response does not expose thumbnail fields.

Dashboard (after unlocking per SKILL.md):

1. `browser_navigate` `/assets` → screenshot `25-assets.png`.
2. Click `#browse-files`, then `browser_file_upload` with `$RUN/dot.svg` → the page reloads and a `dot.svg` row appears in `table.assets-table` → screenshot `26-uploaded.png`.
3. Click its `a.asset-filename` → detail page. The id is the last path segment of the URL. Append `asset\t<id>` to `created.tsv`.
4. Click `#desc-display`, type into `#description`, press Enter → `#desc-status` reads "Saved" and `code[data-snippet="markdown"]` contains the new alt text → screenshot `27-described.png`. Confirm with `$S/req.sh "$RUN" 28-after-describe GET /api/v1/assets/<id>`.
5. List search: fill `input[data-table-search="assets-table"]` with a word from one description → only matching rows stay visible; a nonsense word shows `tr.search-empty`; Escape clears. Thumbnails: `.thumb-sm img` srcs point at `/thumbs/{id}.webp` for png/mp4 rows.
6. Paste: on `/assets`, dispatch a synthetic paste (headless has no real clipboard) and wait for the reload:
   `await page.evaluate(() => new Promise(r => { const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.getContext('2d').fillRect(0, 0, 40, 30); c.toBlob(b => { const dt = new DataTransfer(); dt.items.add(new File([b], 'image.png', { type: 'image/png' })); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); r(); }); }))` inside a snippet that awaited `page.waitForNavigation()` first. The newest row is `pasted-<stamp>.png`. Record its id in `created.tsv` (or delete it in step 7).
7. To check delete: click `#delete-form button[type="submit"]`, screenshot the open `#delete-dialog`, click `button[data-confirm]` → `/assets?deleted=1` with the flash → screenshot. The asset URL → 404. Remove that id from `created.tsv`, or let cleanup's DELETE return 404.

Stepping (needs a few Assets; upload them with explicit types, e.g. `-F "file=@clip.mp4;type=video/mp4"`):

1. `browser_navigate` `/assets/<id of a middle row>` → `.pager-count` reads "n of N" and both pager links have an `href`.
2. `browser_press_key` `ArrowRight` → the URL becomes the `#pager-next` href and the count goes up by one; `ArrowLeft` goes back. `history.length` stays the same, and `browser_navigate_back` lands on `/assets`.
3. On the newest Asset press `ArrowLeft` (on the oldest, `ArrowRight`): the URL does not change and `#pager-status` has the end message.
4. Click `#desc-display` and press `ArrowLeft`: the caret moves and the page stays put. Focus a `<video>` (`document.querySelector("video").focus()`) and press `ArrowRight`: `currentTime` moves and the page stays put; `Escape`, then `ArrowRight`, steps.

## Gotchas

- `url` in the API response is the asset host URL with extension. The bare `/{id}` works too.
- SVGs are served with a sandboxing CSP (`ASSET_DOCUMENT_CSP`). Check that header when `src/lib/csp.ts` changes.
- The upload posts `_csrf` inside its multipart body. That is the one path `admin-guard.ts` exempts from the normal CSRF hook. Changes to `src/lib/admin-guard.ts` or `src/lib/multipart.ts` need the dashboard upload driven, not just the API.
- Headless Chrome reports `pointer: none`, so the touch rules (`pointer: coarse`: 40px pager targets and no key hint) do not apply there. A device preset alone does not flip it. Use mobile and touch emulation (CDP `Emulation.setDeviceMetricsOverride` with `mobile: true` plus `Emulation.setTouchEmulationEnabled`) to check them. Clear `localStorage` to see the key hint again after a key press.
