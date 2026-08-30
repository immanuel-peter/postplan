---
name: html-communication
description: Use when the user asks for an HTML page or a report, or pastes a PostPlan link. Generates self-contained HTML and publishes it to Postplan.
---

# HTML communication

The job is a Draft the user opens in a browser.

`$POSTPLAN_TOKEN` authenticates. Stop if the Token is unset. The live contract is `$POSTPLAN_URL/openapi.json`.

```bash
POSTPLAN_URL="https://postplan.domain" // Use your custom domain for your Postplan app
```

A PostPlan link is fetched with `curl -sS` — raw HTML, never webfetch, which markdown-ifies the source. `publicUrl` is the latest Version; `versionUrl` pins one.

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

A bare link gets a brief read-back of the Draft, then wait for instruction. A link plus a change ("update this") resolves the target, edits the file, and publishes a new Version through steps 2–3.

Done when the target is **create** plus a title, or a Draft `id` plus `currentVersion`.

## 2. Write the file

Write one UTF-8 HTML file. Self-contained means it is a complete document and it runs under the Draft CSP:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src *; frame-ancestors 'none'
```

So: CSS in `<style>`, JS in `<script>`, images and media as `data:` URIs, `font-family` a system stack, `fetch()` to any origin allowed. Also: complete document (`<!doctype html>`, `<html>`, `<body>`), size ≤ 5 MiB. These rules bind the page — the top-level document — even when another skill is also loaded.

Design: curl the frontend-design skill and apply it to the page:

```bash
curl -sS https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/plugins/frontend-design/skills/frontend-design/SKILL.md
```

Reports additionally:

- Written in ASD-STE100: bullets, direct, no verbosity.
- Every graph, figure, and axis labeled.
- One figure in the spotlight at a time; its associated figures sit in tabs beside it.
- Main insights at the top.
- Metadata — sourcing, timestamp — in the footer.

Done when every rule holds and the file is on disk.

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

## 4. Hand back the Version URL

Reply with `versionUrl` (the Version just published). `publicUrl` is the latest URL.

Done when the user has `versionUrl`.
