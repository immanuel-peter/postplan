# Public draft serving

Each active Draft is publicly served on its own subdomain: the latest Version at `/`, any Version at `/v/{n}`. Drafts run arbitrary inline JS, so the CSP and host isolation are the feature.

## Sub-features

- `http://{slug}.postplan.localhost:3005/` → latest Version, `Cache-Control: public, max-age=60, must-revalidate`, `ETag "<draftId>-<n>"`
- `/v/{n}` → that Version's exact bytes, `Cache-Control: ... immutable`, `ETag "<sha256>"`; unknown or non-numeric `n` → 404
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
```

For CSP behavior (not just the header), publish HTML with an inline `<script>` that writes to the DOM plus an `<img src="https://example.com/x.png">`. Then `browser_navigate` to `$D/`, `browser_take_screenshot`, and `browser_console_messages`: the script runs and the external image is blocked by CSP.

After delete (`DELETE /api/v1/drafts/$ID`): `$D/` and `$D/v/1` → 404.

## Gotchas

- `req.sh` prints the CSP header line. Diff it against `src/lib/csp.ts` `draftCsp()` when that file changed.
- 15 should be 304 with an empty body.
- Browsers cache `/v/{n}` as immutable. Use curl for header checks and a fresh Playwright page for rendering.
