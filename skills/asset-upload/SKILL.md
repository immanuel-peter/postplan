---
name: asset-upload
description: Use when the user asks to upload, host, or embed a file (image, video, document, SVG, json). Uploads an Asset to Postplan and hands back a stable public URL plus embed snippets.
---

# Asset upload

The job is a public URL the user can hotlink, `curl`, or paste into a page.

`$POSTPLAN_TOKEN` authenticates. Stop if the Token is unset. The live contract is `$POSTPLAN_URL/openapi.json`.

```bash
POSTPLAN_URL="https://postplan.domain" // Use your custom domain for your Postplan app
```

Bytes are immutable and unversioned: re-uploading identical bytes creates a new id. HTTP cache is 60s plus ETag so a delete vanishes within a minute. Deletes purge immediately (no soft-delete). Upload images, video, documents, SVG, json, and similar. Do not upload HTML or JavaScript; Drafts host those.

## Hosting a file for another app

If the job is to make a local file consumable by something else on the internet (a hosted page, a web app, a URL-only API input, a webhook payload), upload it here and pass `url` onward. The URL needs no auth, answers CORS `*`, caches for 60s with ETag, and keeps a real extension for consumers that sniff type from the path. Not a fit when the consumer needs auth, mutability, or more than 100 MiB; say so and stop.

## 1. Resolve the file

- A local path: must exist, be non-empty, and be ≤ 100 MiB. The basename becomes the stored filename and the URL extension.
- A remote URL: `curl -sSL -o name.ext <url>` to disk first, then treat as local. Never pipe a remote fetch straight into the upload.
- "This image / screenshot / file" after earlier thread context: reuse that path.

Done when a file is on disk, non-empty, ≤ 100 MiB.

## 2. Upload

```bash
curl -sS -X POST "$POSTPLAN_URL/api/v1/assets" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  -F "file=@photo.png"
```

Done when the response is 201 and includes `url` (`https://assets.<domain>/<id>.<ext>`). Record `id`, `url`, `contentType`, `byteSize`, `sha256`.

List / inspect when needed:

```bash
curl -sS -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  "$POSTPLAN_URL/api/v1/assets"

curl -sS -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  "$POSTPLAN_URL/api/v1/assets/$ASSET_ID"
```

Pass `?cursor=` from `nextCursor` until the match is found or the list ends.

## 3. Verify

Byte-match the public URL against the upload, and confirm the content type:

```bash
curl -sS "$ASSET_URL" | cmp - photo.png && echo BYTE-MATCH
curl -sSI "$ASSET_URL" | grep -iE '^(HTTP|content-type|content-length|etag|accept-ranges|cache-control)'
```

Expect 200, the file's `Content-Type`, `Accept-Ranges: bytes`, `Cache-Control` including `max-age=60` and `must-revalidate` (not `immutable`), and an `ETag: "<sha256>"` matching the upload response. Seek check for video/audio: `curl -sS -H "Range: bytes=0-99" -o /dev/null -w "%{http_code}\n" "$ASSET_URL"` expects 206.

Done when bytes match and headers hold.

## 4. Hand back the URL

Reply with the `url` plus the snippet matching the use:

```
Direct:   https://assets.postplan.link/<id>.png
Markdown: ![photo](https://assets.postplan.link/<id>.png)
HTML:     <img src="https://assets.postplan.link/<id>.png" alt="photo">
curl:     curl -O https://assets.postplan.link/<id>.png
```

Drafts can `<img>` or `<video>` the URL. External apps can too (CORS `*`).

Delete only when asked: it is immediate and irreversible.

```bash
curl -sS -X DELETE "$POSTPLAN_URL/api/v1/assets/$ASSET_ID" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN"
```

Done when the response is 204.

Done when the user has `url` (and the snippet).
