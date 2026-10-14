# Dashboard: drafts

The owner's view of everything published: a Drafts table with favorites, a details page with version history, and title/description edits and delete. Lives on the apex host only, behind the passkey gate.

## Sub-features

- List `/` (`h1` "Drafts"): one `table.drafts-table` row per Draft, newest first, with favorites pinned to the top (`tr.is-favorite`). Columns: star, title, repository, version, updated, details.
- Filter: `nav.segmented` (`aria-label="Filter drafts"`) with `a[href="/"]` (All) and `a[href="/?show=favorites"]` (Favorites). The active one has `aria-current="page"`; each shows a `.count`. Empty states are `tr.empty-row`.
- Favorite toggle: `form[action="/drafts/{id}/favorite"]` → `button.star-btn` (`aria-label` "Add to favorites" / "Remove from favorites", `aria-pressed`). Redirects back to `/`, or `/?show=favorites` when toggled from that view. Dashboard-only: there's no API field.
- Title link `a.cell-title` → the slug host root (`publicUrl`), **not** `/v/{n}` and not `/drafts/{id}` (product rule)
- Repository cell: `.col-repo .repo-link` (an `<a>` when `repositoryUrl` is set, else a `<span>`), `.repo-owner` / `.repo-name`; `—` when no repository
- Timestamps: `time[data-local]` gets rewritten to local time by `/static/localtime.js`. The server label is UTC.
- Details link `a[href="/drafts/{id}"]` → detail page: `h1` title, `a.public-url`, `table.versions-table` (one row per Version linking to `/v/{n}`, commit/ref/published)
- Edit: `form.edit-form[action="/drafts/{id}"]` with `#title`, `#description`, submit "Save". No repository or git fields (those are API-only).
- Delete: `form.delete-form[action="/drafts/{id}/delete"]` ("Delete draft", native `confirm()`) → back to `/`, row gone, slug host 404

## How to get to it (user POV)

Open `http://postplan.localhost:3005/`, unlock with a passkey, land on **Drafts** (nav `a[href="/"]`).

## Driving it with Playwright

1. Seed through the API so the list has known content: publish-and-versions steps 01–02 (Draft with `repository_name=verify/postplan`, two versions).
2. Unlock (SKILL.md → Dashboard). `browser_navigate` `/`. `browser_snapshot`, screenshot `30-list.png`.
3. Assert the row for the Draft title shows `verify/postplan` in `.col-repo`, `v2` in its version, and an `a.cell-title` href equal to the API `publicUrl`.
4. Click that row's `button.star-btn` ("Add to favorites") → screenshot `31-favorited.png`. The row is now `tr.is-favorite` at the top, and the Favorites `.count` went up by one. `browser_navigate` `/?show=favorites` → the Draft is listed. Then `$S/psql.sh "select favorite from drafts where id='$ID'" > "$RUN/32-favorite.sql.txt"` shows `t`.
5. Click `a[href="/drafts/$ID"]` → screenshot `33-detail.png`. Expect two rows in `table.versions-table`.
6. Fill `#title` with a new title, submit `.edit-form`. Screenshot `34-edited.png`. Confirm with `$S/req.sh "$RUN" 35-after-edit GET /api/v1/drafts/$ID`.
7. Submit `.delete-form` with `browser_handle_dialog accept: true` → screenshot `36-after-delete.png`. Then `$S/req.sh "$RUN" 37-public-gone GET "http://$SLUG.postplan.localhost:3005/"` → 404.

## Gotchas

- `/`, `/drafts/:id`, `/keys`, `/assets` all redirect to `/unlock?next=…` without a session. A screenshot of the unlock page is a failed run, not evidence.
- Titles open in a new tab (`target="_blank"`). Check the href rather than following it.
- The Favorites view's star form carries a hidden `show=favorites`. Toggle from both views when the redirect logic changed.
- Draft delete still uses native `confirm()`. Asset delete and token revoke use a `<dialog>` instead (see their files).
- Unfavoriting is the cleanup for step 4 when the Draft isn't deleted afterwards.
