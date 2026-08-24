---
name: html-communication
description: Use when user wants an HTML page generated for them. Generate the HTML file and publish it to Postplan.
---

# HTML communication

The job is a Draft the user opens in a browser.

`$POSTPLAN_TOKEN` authenticates. Stop if the Token is unset. The live contract is `$POSTPLAN_URL/openapi.json`.

```bash
POSTPLAN_URL="https://postplan.domain"
```

## 1. Resolve the target

- A `.postplan.` URL: the slug is the DNS label immediately left of `postplan.`. List Drafts until `slug` matches. Read `id` and `currentVersion`.
- A named Draft, or "update this" after a create in this thread: reuse that `id` and GET `currentVersion`.
- Otherwise create. Pick a title the drafts list can show.

Versions are append-only. A publish always creates the next number.

```bash
curl -sS -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  "$POSTPLAN_URL/api/v1/drafts"

curl -sS -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  "$POSTPLAN_URL/api/v1/drafts/$DRAFT_ID"
```

Pass `?cursor=` from `nextCursor` until the match is found or the list ends.

Done when the target is **create** plus a title, or a Draft `id` plus `currentVersion`.

## 2. Write the file

Write one UTF-8 HTML file. Self-contained means it is a complete document and it runs under the Draft CSP:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src *; frame-ancestors 'none'
```

Apply every rule:

- Complete document: `<!doctype html>`, `<html>`, `<body>`.
- CSS in `<style>`, JS in `<script>`.
- Images and media as `data:` URIs.
- `font-family` is a system stack.
- `fetch()` may call any origin.
- Size ≤ 5 MiB.

These rules hold even when another skill is loaded. The page is the top-level document.

Done when every rule holds and the file is on disk.

## 3. Publish

Create:

```bash
curl -sS -X POST "$POSTPLAN_URL/api/v1/drafts" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  -F "html=@page.html;type=text/html" \
  -F "title=Title"
```

When the file lives in a git checkout, also send `-F repository_url=`, `-F repository_name=`, `-F git_ref=`, `-F git_commit=`.

Version. Send `If-Match` as the quoted `currentVersion` integer from the JSON body. The response `ETag` names the Draft, not the Version number.

```bash
curl -sS -X POST "$POSTPLAN_URL/api/v1/drafts/$DRAFT_ID/versions" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  -H "If-Match: \"$CURRENT_VERSION\"" \
  -F "html=@page.html;type=text/html"
```

Done when the response is 201 and includes `versionUrl`.

## 4. Hand back the Version URL

Reply with `versionUrl` (the Version just published). `publicUrl` is the latest URL.

Done when the user has `versionUrl`.
