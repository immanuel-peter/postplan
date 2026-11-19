# Public draft serving

Each active Draft is publicly served on its own subdomain: the latest Version at `/`, any Version at `/v/{n}`. Drafts run arbitrary inline JS, so the CSP and host isolation are the feature.

## Sub-features

- `http://{slug}.postplan.localhost:3005/` → latest Version, `Cache-Control: public, max-age=60, must-revalidate`, `ETag "<draftId>-<n>.<preview fingerprint>"`
- `/v/{n}` → that Version's bytes, `Cache-Control: ... immutable`, `ETag "<sha256>.<preview fingerprint>"`; unknown or non-numeric `n` → 404
- Link previews (ADR 0009): both pages get `og:*` and `twitter:card` meta tags inserted right after `<head>`, skipping any key the HTML already declares; every other byte is the stored Version. `og:image` points at `/og.png` (or `/v/{n}/og.png`), a 1200×630 PNG card: Postplan wordmark, `v{n}` chip, slug host pill, title (3 lines max), description (2 lines max). Card: `Content-Type: image/png`, `ETag "og-<hash>"`, 60 s cache. A title or description edit changes the page and card ETags without a new Version. An untitled Draft's card falls back to the HTML's `og:title`/`<title>`
- `Content-Security-Policy`: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: <assets origin>; media-src ...; connect-src *; frame-ancestors 'none'` (ADR 0003)
- Draft favicons: `/favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png` on the draft host
- Any other path on a draft host → 404; deleted Draft → 404 at `/` and `/v/{n}`
- Host dispatch: dashboard routes (`/keys`, `/api/v1/...`) are not reachable on a draft host

## How to get to it (user POV)

Anyone opens the `publicUrl` from the API, or clicks a Draft title on the dashboard's drafts list. No auth.

## Driving it with curl and Playwright

Create a Draft first (publish-and-versions steps 01–02), then:

```bash
D="http://$SLUG.postplan.localhost:3005"
$S/req.sh "$RUN" 10-root GET "$D/"
$S/req.sh "$RUN" 11-v2 GET "$D/v/2"
$S/req.sh "$RUN" 12-v99 GET "$D/v/99"
$S/req.sh "$RUN" 13-other-path GET "$D/keys"
$S/req.sh "$RUN" 14-favicon GET "$D/favicon.svg"
$S/req.sh "$RUN" 15-conditional GET "$D/" -H "If-None-Match: $(grep -i '^etag:' "$RUN/10-root.headers" | cut -d' ' -f2- | tr -d '\r')"
$S/req.sh "$RUN" 16-og GET "$D/og.png" && cp "$RUN/16-og.body" "$RUN/16-og.png"
$S/req.sh "$RUN" 17-v1-og GET "$D/v/1/og.png"
$S/req.sh "$RUN" 18-v99-og GET "$D/v/99/og.png"
```

`10-root.body` shows the injected `<meta property="og:…">` block; read `16-og.png` to check the card. For a title edit, `PATCH /api/v1/drafts/$ID` with a new `title`, then repeat 10 and 16 with the old ETags as `If-None-Match`: both must be 200 with new ETags. For a Draft that declares its own `og:image`, the served HTML keeps it and gains no `og:image:*` tags.

For CSP behavior (not just the header), publish HTML with an inline `<script>` that writes to the DOM plus an `<img src="https://example.com/x.png">`. Then `browser_navigate` to `$D/`, `browser_take_screenshot`, and `browser_console_messages`: the script runs and the external image is blocked by CSP.

After delete (`DELETE /api/v1/drafts/$ID`): `$D/` and `$D/v/1` → 404.

## Gotchas

- `req.sh` prints the CSP header line. Diff it against `src/lib/csp.ts` `draftCsp()` when that file changed.
- 15 should be 304 with an empty body.
- `req.sh` prints a `sed: illegal byte sequence` line for PNG bodies. Harmless: the body file is intact.
- `/og.png` on the apex redirects to `/unlock` (dashboard catch-all) and 404s on the assets host. Only draft hosts serve cards.
- Browsers cache `/v/{n}` as immutable. Use curl for header checks and a fresh Playwright page for rendering.
