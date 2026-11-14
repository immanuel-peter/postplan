---
name: style-report
description: Use when the user asks for a styled report, or turns findings, data, or analysis into an HTML report. Produces a self-contained HTML file ready for upload, without publishing.
---

# Style report

The job is one UTF-8 HTML file on disk, a styled report the user can later publish with the `upload-postplan` skill.

Write one self-contained HTML file. Self-contained means it is a complete document and it runs under the Draft CSP:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: https://assets.<domain>; media-src 'self' data: blob: https://assets.<domain>; connect-src *; frame-ancestors 'none'
```

So: CSS in `<style>`, JS in `<script>`, images and media via Asset URLs (`https://assets.<domain>/<id>.<ext>` after the asset-upload skill) or `data:`/`blob:`/`self`, `font-family` a system stack, `fetch()` to any origin allowed. Also: complete document (`<!doctype html>`, `<html>`, `<body>`), size ≤ 5 MiB.

## Apply report styling

Design: apply the frontend-design skill. If it exists on the machine, use that copy. Otherwise curl it:

```bash
curl -sS https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/plugins/frontend-design/skills/frontend-design/SKILL.md
```

Reports additionally:

- Written in ASD-STE100: bullets, direct, no verbosity.
- Every graph, figure, and axis labeled.
- One figure in the spotlight at a time; its associated figures sit in tabs beside it.
- Main insights at the top.
- Metadata — sourcing, timestamp — in the footer.

Done when every rule holds and the file is on disk. Hand the file path to the caller; publishing belongs to `upload-postplan`.
