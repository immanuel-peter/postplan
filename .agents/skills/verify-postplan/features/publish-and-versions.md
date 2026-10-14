# Publish and versions (API)

Agents publish self-contained HTML to `/api/v1`. Creating a Draft publishes Version 1. Every later publish appends the next number, with no gaps and no rollback.

## Sub-features

- Create a Draft: `POST /api/v1/drafts` (multipart `html` file + optional `title`, `description`, `repository_url`, `repository_name`, `git_ref`, `git_commit`) → 201, `ETag`, body with `id`, `slug`, `currentVersion: 1`, `publicUrl`, `versionUrl`, `contentSha256`
- Idempotent create: same `Idempotency-Key` + same request → same Draft; same key + different request → 409
- Append a Version: `POST /api/v1/drafts/{id}/versions` with `If-Match: "<current>"` (or `expectedVersion` field) → 201, `currentVersion` = current + 1
- Optimistic concurrency: stale `If-Match` → 409 with `currentVersion`; missing precondition → 428
- List and read: `GET /api/v1/drafts`, `GET /api/v1/drafts/{id}`, `GET /api/v1/drafts/{id}/versions`, `GET /api/v1/drafts/{id}/versions/{n}`
- Metadata: `PATCH /api/v1/drafts/{id}` (JSON `title`, `description`, `repositoryUrl`, `repositoryName`, `gitRef`, `gitCommit`). Repository fields are set only here, never in the dashboard.
- Soft delete: `DELETE /api/v1/drafts/{id}` → 204

## How to get to it (user POV)

An agent or script with a `pp_…` token runs curl against `http://postplan.localhost:3005/api/v1` (contract: `/openapi.json`). Then it opens the returned `publicUrl`.

## Driving it with curl

```bash
printf '<!doctype html><title>v1</title><h1>verify v1</h1>' > "$RUN/v1.html"
printf '<!doctype html><title>v2</title><h1>verify v2</h1>' > "$RUN/v2.html"
$S/req.sh "$RUN" 01-create POST /api/v1/drafts \
  -F "html=@$RUN/v1.html;type=text/html" -F "title=verify $(basename "$RUN")" \
  -F repository_name=verify/postplan -F git_ref=main
ID=$($S/field.sh "$RUN/01-create.body" id)
SLUG=$($S/field.sh "$RUN/01-create.body" slug)
$S/req.sh "$RUN" 02-append POST "/api/v1/drafts/$ID/versions" -H 'If-Match: "1"' -F "html=@$RUN/v2.html;type=text/html"
$S/req.sh "$RUN" 03-stale POST "/api/v1/drafts/$ID/versions" -H 'If-Match: "1"' -F "html=@$RUN/v1.html;type=text/html"
$S/req.sh "$RUN" 04-no-precondition POST "/api/v1/drafts/$ID/versions" -F "html=@$RUN/v1.html;type=text/html"
$S/req.sh "$RUN" 05-versions GET "/api/v1/drafts/$ID/versions"
$S/req.sh "$RUN" 06-latest GET "http://$SLUG.postplan.localhost:3005/"
$S/req.sh "$RUN" 07-v1 GET "http://$SLUG.postplan.localhost:3005/v/1"
$S/psql.sh "select version_number, byte_size from draft_versions where draft_id='$ID' order by 1" > "$RUN/08-version-rows.sql.txt"
```

Pass when: 01 → 201 `currentVersion: 1`; 02 → 201 `currentVersion: 2`; 03 → 409 with `currentVersion: 2`; 04 → 428; 05 lists 1 and 2; 06 body contains `verify v2` and 07 body contains `verify v1` (the bytes really landed in Garage); 08 shows exactly rows 1 and 2.

## Gotchas

- `If-Match` is the quoted number, `"1"`, not the `ETag` string.
- `req.sh` records the Draft in `created.tsv`; cleanup soft-deletes it. Version rows stay, by design.
- The bootstrap token only exists if the token table was empty when the app first booted. If doctor's `/api/v1/me` check fails, the `.env` value doesn't match the seeded token. Ask the user for a token. Don't reseed.
