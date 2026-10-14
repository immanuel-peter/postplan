# Dashboard: drafts

The owner's view of everything published: Drafts grouped by repository, a details page with version history, and title/description edits and delete. Lives on the apex host only, behind the passkey gate.

## Sub-features

- List `/` ("My drafts"): `section.group` per repository (`h2` heading, `a.github` link when `repositoryUrl` is set), `article.draft-row` per Draft
- Title link `a.draft-title` → the slug host root (`publicUrl`), **not** `/v/{n}` and not `/drafts/{id}` (product rule)
- Details link `a[href="/drafts/{id}"]` → detail page: `h1` title, `a.public-url`, version table (`table.plain`, one row per Version linking to `/v/{n}`, commit/ref/published)
- Edit: `form.edit-form[action="/drafts/{id}"]` with `#title`, `#description`. No repository or git fields (those are API-only).
- Delete: `form.delete-form[action="/drafts/{id}/delete"]` (confirm dialog) → back to `/`, Draft gone from the list, slug host 404
- Empty state: `.lede` "No drafts yet…"

## How to get to it (user POV)

Open `http://postplan.localhost:3005/`, unlock with a passkey, land on **My drafts**.

## Driving it with Playwright

1. Seed through the API so the list has known content: publish-and-versions steps 01–02 (Draft with `repository_name=verify/postplan`, two versions).
2. Unlock (SKILL.md → Dashboard). `browser_navigate` `/`. `browser_snapshot`, screenshot `30-list.png`.
3. Assert the group heading `verify/postplan` contains the Draft title, and that the `a.draft-title` href equals the API `publicUrl`.
4. Click `a[href="/drafts/$ID"]` → screenshot `31-detail.png`. Expect two version rows.
5. Fill `#title` with a new title, submit `.edit-form`. Screenshot `32-edited.png`. Confirm with `$S/req.sh "$RUN" 33-after-edit GET /api/v1/drafts/$ID`.
6. Submit `.delete-form` with `browser_handle_dialog accept: true` → screenshot `34-after-delete.png`. Then `$S/req.sh "$RUN" 35-public-gone GET "http://$SLUG.postplan.localhost:3005/"` → 404.

## Gotchas

- `/`, `/drafts/:id`, `/keys`, `/assets` all redirect to `/unlock?next=…` without a session. A screenshot of the unlock page is a failed run, not evidence.
- Titles open in a new tab (`target="_blank"`). Check the href rather than following it.
- Grouping is by the `repository_name` string. Drafts without one fall into a default group.
