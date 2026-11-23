# Public draft serving

Each active Draft is publicly served on its own subdomain: the latest Version at `/`, any Version at `/v/{n}`. Drafts run arbitrary inline JS, so the CSP and host isolation are the feature.

## Sub-features

- `http://{slug}.postplan.localhost:3005/` → latest Version, `Cache-Control: public, max-age=60, must-revalidate`, `Vary: Accept-Encoding`, `ETag "<draftId>-<n>.<preview fingerprint>"`
- `/v/{n}` → that Version, `Cache-Control: ... immutable`, no `Vary`, `ETag "<sha256>.<preview fingerprint>"`; unknown or non-numeric `n` → 404
- Link previews: both pages get `og:*` and `twitter:card` meta tags inserted right after `<head>`, skipping any key the HTML already declares; every other byte is the stored Version. `og:image` points at `/og.png` (or `/v/{n}/og.png`), a 1200×630 PNG card: Postplan wordmark, `v{n}` chip, slug host pill, title (3 lines max), description (2 lines max). Card: `Content-Type: image/png`, `ETag "og-<hash>"`, 60 s cache. The fingerprint is a hash of title and description, so a title or description edit changes the page and card ETags without a new Version. An untitled Draft's card falls back to the HTML's `og:title`/`<title>`
- Download: `?download=1` on `/` or `/v/{n}` (exactly `1`; `download=true` or `0` gets the normal page) → the stored bytes with no preview tags, `Content-Disposition: attachment; filename="{slug}-v{n}.html"`, `ETag "<sha256>.download"`, same Cache-Control as the page. A matching `If-None-Match` → 304, still carrying `Content-Disposition`. The dashboard's Download buttons link here (dashboard-drafts)
- `Content-Security-Policy`: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: <assets origin>; media-src 'self' data: blob: <assets origin>; font-src data:; connect-src *; frame-ancestors 'none'`
- Draft favicons: `/favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png` on the draft host
- Any other path on a draft host → 404; deleted Draft → 404 at `/`, `/v/{n}`, `?download=1`, `/og.png`, and `/v/{n}/og.png`
- Host dispatch: dashboard routes (`/keys`, `/api/v1/...`, `/sw.js`) are not reachable on a draft host

## How to get to it (user POV)

Anyone opens the `publicUrl` from the API, or clicks a Draft title on the dashboard's drafts list. Chat apps and social sites fetch the page and its `/og.png` to unfurl a shared link. No auth.

## Driving it with curl and Playwright

Create a Draft first (publish-and-versions steps 01–02; give it a `description` so the card shows one), then:

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
$S/req.sh "$RUN" 19-download GET "$D/?download=1"
$S/req.sh "$RUN" 19b-v1-download GET "$D/v/1?download=1" && cmp "$RUN/19b-v1-download.body" "$RUN/v1.html"
$S/req.sh "$RUN" 19c-download-true GET "$D/v/1?download=true"
$S/req.sh "$RUN" 19d-download-304 GET "$D/v/1?download=1" -H "If-None-Match: $(grep -i '^etag:' "$RUN/19b-v1-download.headers" | cut -d' ' -f2- | tr -d '\r')"
```

Pass when: 10 and 11 carry the `.<fingerprint>` ETags and the injected `<meta property="og:…">` block; 12, 13, 18 → 404; 15 → 304; 16 and 17 → `image/png` (read `16-og.png` to check the card); 19 names `{slug}-v2.html` and 19b names `{slug}-v1.html`, both `attachment`, with no `og:` tags in the body, and `cmp` is silent; 19c is the normal page with preview tags; 19d → 304 with `Content-Disposition`.

For a title edit, `PATCH /api/v1/drafts/$ID` with a new `title` (or edit it on the dashboard), then repeat 10 and 16 with the old ETags as `If-None-Match`: both must be 200 with new ETags. For a Draft that declares its own `og:image`, the served HTML keeps it and gains no `og:image:*` tags.

For CSP behavior (not just the header), publish HTML with an inline `<script>` that writes to the DOM, an `<img src="https://example.com/x.png">`, and two `@font-face` rules used on the page: one `data:font/woff2;base64,…` (e.g. a font from `node_modules/@ibm/plex-mono/fonts/complete/woff2/`) and one external URL (`https://example.com/font.woff2`). Open `$D/` in the browser, wait for `document.fonts.ready`, and check `document.fonts` plus a screenshot: the script runs, the `data:` font is `loaded`, and both the external font (`error`) and external image are blocked.

After delete (`DELETE /api/v1/drafts/$ID`): `$D/`, `$D/v/1`, `$D/?download=1`, `$D/og.png`, `$D/v/1/og.png` → 404.

## Gotchas

- `req.sh` prints the CSP, ETag, Vary and Content-Disposition lines. Diff the CSP against `src/lib/csp.ts` `draftCsp()` when that file changed.
- `agent-browser console`/`errors` omit CSP violations; verify blocking via `document.fonts` and `agent-browser network requests` (blocked requests have no status).
- 15 and 19d are 304 with an empty body.
- `/og.png` on the apex redirects to `/unlock` (dashboard catch-all) and 404s on the assets host. Only draft hosts serve cards.
- Browsers cache `/v/{n}` as immutable, even though its preview tags and ETag change when the title or description is edited. Use curl for header checks and a fresh Playwright page for rendering.
