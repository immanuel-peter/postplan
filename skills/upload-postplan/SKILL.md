---
name: upload-postplan
description: Use when the user asks to upload, publish, or update a Postplan draft, or pastes a Postplan link and asks for an update. Takes a self-contained HTML file and publishes it, returning the public URL.
---

# Upload to Postplan

The job is a Draft publishing step: an existing HTML file goes in, a public URL comes out.

`$POSTPLAN_TOKEN` authenticates. Stop if the token is unset. The live contract is `$POSTPLAN_URL/openapi.json`.

> **Note**: If unset in this shell, probe the login shell once without printing the value. If still unset, stop and ask privately. When the login shell has it, run `curl` under the same `zsh -ic '...'` / `bash -lc '...'` wrapper so the token resolves.
> ```bash
> # macOS
> zsh -ic '[ -n "$POSTPLAN_TOKEN" ] && echo TOKEN_SET'
>
> # Linux
> bash -lc '[ -n "$POSTPLAN_TOKEN" ] && echo TOKEN_SET'
> ```

```bash
POSTPLAN_URL="https://postplan.domain" # Use your custom domain for your Postplan app
```

A Postplan link is fetched with `curl -sS` — raw HTML, never webfetch, which markdown-ifies the source. `publicUrl` is the latest Version; `versionUrl` pins one.

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

A bare link gets a brief read-back of the Draft, then wait for instruction. A link plus a change ("update this") resolves the target, then publishes through steps 2–3.

Done when the target is **create** plus a title, or a Draft `id` plus `currentVersion`.

## 2. Validate and prepare the file

Check the HTML file before publishing. Confirm every item holds:

- UTF-8, complete document (`<!doctype html>`, `<html>`, `<body>`), size ≤ 5 MiB.
- CSS lives in `<style>`, JS in `<script>`, `font-family` is a system stack.
- Images and media use Asset URLs (`https://assets.<domain>/<id>.<ext>`), `data:`, `blob:`, or `self`.
- The document runs under the Draft CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: https://assets.<domain>; media-src 'self' data: blob: https://assets.<domain>; connect-src *; frame-ancestors 'none'`

If the page needs an image, video, or similar file for ingress and render, use the `asset-upload` skill. Put the returned Asset URL in the HTML. Skip asset upload when the page has none.

Done when the checklist holds and every needed Asset has a public URL, or there are none.

## 3. Publish

Create, with title ≤ 25 chars and description ≤ 80 chars:

```bash
curl -sS -X POST "$POSTPLAN_URL/api/v1/drafts" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  -F "html=@page.html;type=text/html" \
  -F "title=Title" \
  -F "description=One-line summary"
```

When the file lives in a git checkout, also send `-F repository_url=`, `-F repository_name=`, `-F git_ref=`, `-F git_commit=`.

Version: send `expectedVersion` as the `currentVersion` from the JSON body.

```bash
curl -sS -X POST "$POSTPLAN_URL/api/v1/drafts/$DRAFT_ID/versions" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  -F "expectedVersion=$CURRENT_VERSION" \
  -F "html=@page.html;type=text/html"
```

Done when the response is 201 and includes `versionUrl`.

## 4. Hand back the public URL

Reply with `publicUrl` (the latest Version). Note which Version number the Draft is now at if useful. Do not lead with `versionUrl`.

Done when the user has `publicUrl`.
