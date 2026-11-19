# Dashboard: drafts

The owner's view of everything published: a Drafts table with favorites, a details page with version history and downloads, in-place title/description edits, and delete. Lives on the apex host only, behind the passkey gate, in an installable app shell.

## Sub-features

- List `/` (`h1` "Drafts"): one `table.drafts-table` row per active Draft (all of them, not paged), favorites pinned to the top (`tr.is-favorite`), each group newest-updated first; the first row below the favorites gets `tr.after-favorites`. Columns: star, title, repository, version, updated, details. On phones a `.row-meta` line under the title carries a second Details link.
- Search: `input[data-table-search="drafts-table"]` ("Search drafts…") sits in the Title header of `table#drafts-table`, only when the view has rows. It filters client-side via `/static/table-search.js`: every whitespace-separated word must appear (case-insensitive) in `.cell-title`, `.draft-desc`, or `.repo-text`. Hidden rows get `hidden`, the table gets `.is-filtered`, and no match shows `tr.search-empty` "No drafts match your search." Escape clears it. It searches the rendered rows only, not the server. The first `tbody tr` is the hidden `tr.search-empty`, so skip it when asserting row order.
- Filter: `nav.segmented` (`aria-label="Filter drafts"`) with `a[href="/"]` (All) and `a[href="/?show=favorites"]` (Favorites). The active one has `aria-current="page"`; each shows a `.count`. Empty states are `tr.empty-row` ("No drafts yet…" / "No favorites yet…").
- Favorite toggle: `form[action="/drafts/{id}/favorite"]` → `button.star-btn` (`aria-label` "Add to favorites" / "Remove from favorites", `aria-pressed`). Redirects back to `/`, or `/?show=favorites` when toggled from that view. Dashboard-only: there's no API field.
- Title link `a.cell-title` → the slug host root (`publicUrl`), **not** `/v/{n}` and not `/drafts/{id}` (product rule)
- Repository cell: `.col-repo .repo-link` (an `<a>` when `repositoryUrl` is set, else a `<span>`), `.repo-owner` / `.repo-name`; `—` when no repository
- Timestamps: `time[data-local]` gets rewritten to local time by `/static/localtime.js`. The server label is UTC.
- Details link `.col-details a[href="/drafts/{id}"]` → detail page: `h1` holding `button[aria-label="Edit title"]`, `a.public-url#draft-url` with `button[data-copy="draft-url"]`, `table.versions-table` (one row per Version linking to `/v/{n}`, commit (`dirty` chip when none)/ref/published)
- Download: page action `.page-actions a[download]` → `{publicUrl}?download=1` (latest Version); each Versions row has `a.icon-btn[download][aria-label="Download v{n}"]` → `/v/{n}?download=1`. The browser saves `{slug}-v{n}.html`, the stored bytes without preview tags (public-draft-serving). Open (`target="_blank"`) sits beside it.
- Edit in place: `button[aria-label="Edit title"]` / `button[aria-label="Edit description"]` open `form.title-form[data-inline="title"]` (`#title`) and `form.desc-form[data-inline="description"]` (`#description`). Enter saves via `fetch` POST to `/drafts/{id}` with `Accept: application/json`, Esc cancels, a "Saved" status shows; no page load. No repository or git fields (those are API-only).
- Delete: `form#delete-form[action="/drafts/{id}/delete"]` (button "Delete") opens `dialog#delete-dialog` → `[data-confirm]` "Delete draft" (`[data-cancel]` cancels) → back to `/`, row gone, slug host 404. Native `confirm()` is only the fallback without `<dialog>` support.
- App shell (`main.eta`): `link[rel="manifest"]` → `/manifest.webmanifest` (`application/manifest+json`), and the page registers `/sw.js` (`Cache-Control: no-cache`; `__OFFLINE_VERSION__` is replaced with a hash of `offline.html`, so the cache name changes when the offline page does). The worker precaches `/static/offline.html?v=<hash>` and shows it when a navigation fails offline. `/sw.js` and the manifest are apex-only (404 on a draft host).
- Nav Lock button: at `max-width: 480px` the "Lock" label is visually hidden (still in the accessibility tree, `title="Lock"`) and only a 16px icon shows.

## How to get to it (user POV)

Open `http://postplan.localhost:3005/`, unlock with a passkey, land on **Drafts** (nav `a[href="/"]`).

## Driving it with Playwright

1. Seed through the API so the list has known content: publish-and-versions steps 01–02 (Draft with `repository_name=verify/postplan`, two versions).
2. Unlock (SKILL.md → Dashboard). `browser_navigate` `/`. `browser_snapshot`, screenshot `30-list.png`.
3. Assert the row for the Draft title shows `verify/postplan` in `.col-repo`, `v2` in its version, and an `a.cell-title` href equal to the API `publicUrl`.
4. Click that row's `button.star-btn` ("Add to favorites") → screenshot `31-favorited.png`. The row is now `tr.is-favorite` at the top, and the Favorites `.count` went up by one. `browser_navigate` `/?show=favorites` → the Draft is listed. Then `$S/psql.sh "select favorite from drafts where id='$ID'" > "$RUN/32-favorite.sql.txt"` shows `t`.
5. Fill `input[data-table-search="drafts-table"]` with a word from the Draft title plus `postplan` → only that row is visible and the table has `.is-filtered` → screenshot `32b-search.png`. Fill a nonsense word → `tr.search-empty` shows. Press Escape → input empty, `.is-filtered` gone.
6. Click `.col-details a[href="/drafts/$ID"]` → screenshot `33-detail.png`. Expect two rows in `table.versions-table`, `.page-actions a[download]` href `{publicUrl}?download=1`, and `a[aria-label="Download v1"]` href ending `/v/1?download=1`.
7. Downloads, in one `browser_run_code_unsafe` snippet: `const [d] = await Promise.all([page.waitForEvent('download'), page.locator('a[aria-label="Download v1"]').click()]); await d.saveAs('<RUN>/33b-v1.html'); return d.suggestedFilename();` → `{slug}-v1.html`, and `cmp "$RUN/33b-v1.html" "$RUN/v1.html"` is silent. Repeat with `.page-actions a[download]` → `{slug}-v2.html`.
8. Click `button[aria-label="Edit title"]`, fill `#title`, press Enter, wait for "Saved". Screenshot `34-edited.png`. Confirm with `$S/req.sh "$RUN" 35-after-edit GET /api/v1/drafts/$ID`.
9. Click `#delete-form button[type="submit"]`, wait for `#delete-dialog[open]`, screenshot it, click `#delete-dialog [data-confirm]` → `/`, screenshot `36-after-delete.png`. Then `$S/req.sh "$RUN" 37-public-gone GET "http://$SLUG.postplan.localhost:3005/"` → 404.

App shell, when `main.eta`, `sw.js`, the manifest or `offline.html` changed: `$S/req.sh "$RUN" 60-manifest GET /manifest.webmanifest` and `$S/req.sh "$RUN" 61-sw GET /sw.js` (200, `no-cache`, body has no `__OFFLINE_VERSION__`), `$S/req.sh "$RUN" 62-offline GET /static/offline.html`. In the unlocked page, `await navigator.serviceWorker.getRegistration()` has a `/sw.js` script. For the Lock button, `browser_resize` to 400×800 on `/`: `.nav-lock span` is 1px wide and the `svg` 16px; screenshot `53-nav-mobile.png`, then resize back.

## Gotchas

- `/`, `/drafts/:id`, `/keys`, `/assets` all redirect to `/unlock?next=…` without a session. A screenshot of the unlock page is a failed run, not evidence.
- Titles open in a new tab (`target="_blank"`). Check the href rather than following it.
- The Favorites view's star form carries a hidden `show=favorites`. Toggle from both views when the redirect logic changed.
- Draft delete, asset delete and token revoke all use an in-page `<dialog>`; `browser_handle_dialog` never fires for them.
- Each list row has two `a[href="/drafts/{id}"]` links (`.row-meta` and `.col-details`). Scope the selector to `.col-details`.
- Unfavoriting is the cleanup for step 4 when the Draft isn't deleted afterwards.
