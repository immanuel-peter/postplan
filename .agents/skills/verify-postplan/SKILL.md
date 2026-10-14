---
name: verify-postplan
description: Drive the local Postplan stack (Fastify app + Postgres + Garage via docker compose) to prove a change works — the /api/v1 publish API with curl, public Draft and Asset hosts, and the passkey-gated Eta dashboard with Playwright MCP, scoped to the features the diff touches. Use after changing anything under src/, drizzle/, compose.yaml, or the Dockerfile, or when asked to verify, smoke test, or show a Postplan feature working, including attaching screenshots or recordings to a PR.
---

# Verify Postplan

One stack, one instance: `compose.yaml` pins `container_name: postplan-*` and fixed host ports, so a second copy cannot run beside it. The local stack exists for agents: its dashboard identity is an agent's virtual passkey (below), and agents share it across runs. Drive it in place, delete only what your run created, and never run `docker compose down -v`. That wipes the data and the enrolled passkey, and leaves `.verify/auth/passkey.json` pointing at nothing.

| Host | URL |
|---|---|
| Dashboard + API | `http://postplan.localhost:3005` (`/api/v1`, `/openapi.json`) |
| Draft | `http://{slug}.postplan.localhost:3005/`, `/v/{n}` |
| Asset | `http://assets.postplan.localhost:3005/{id}[.ext]` |

`*.postplan.localhost` resolves to loopback on macOS. Port 3005 is deliberate: Hostess holds 3000 and 5432 on this machine. `PORT` in the container must equal the host port, because passkey and CSRF origin checks compare against `http://postplan.localhost:${PORT}`.

All helpers live in `.agents/skills/verify-postplan/scripts/` (below: `$S`) and work from any cwd.

## 1. Scope

```bash
S=.agents/skills/verify-postplan/scripts
$S/scope.sh            # or: $S/scope.sh <base-ref>
```

It lists the changed files and the `features/<name>.md` files to drive. `features/README.md` has the same mapping as a table.

Drive the blast radius of the change, not the whole app. Within each listed feature, cover the sub-features the diff can affect, through every entry point the feature file lists for them (API and dashboard, if both exist). Skip features `scope.sh` doesn't list. In particular, skip the dashboard and passkey steps entirely unless a dashboard feature is in scope. Widen the scope only when the diff touches shared code that `scope.sh` maps to several features (`src/routes/api.ts`, migrations, `src/app.ts`). Changes with no mapped feature (docs, skills) need no run. Say so in the report.

## 2. Launch

```bash
RUN=$($S/new-run.sh <short-label>)   # .verify/runs/<utc>-<label>/
$S/launch.sh "$RUN"
```

`launch.sh` runs `docker compose up --build -d` (rebuilds the app image from the working tree; migrations run on container start), then waits for `/readyz`. It prints `ready: http://postplan.localhost:3005`. If the stack was down, it writes `$RUN/started-stack` so cleanup stops only what this run started.

## 3. Doctor

```bash
$S/doctor.sh
```

Read-only. Run it after launch and whenever anything looks off. `FAIL` lines mean stop and fix before driving:

- container running and healthy, started from this checkout, `PORT=3005`
- `/readyz` ok. Ignore its `migration` field: it is a hardcoded string in `src/server.ts`. The real check is the next line.
- migrations applied == entries in `drizzle/meta/_journal.json`
- image newer than every file in `src/`, `drizzle/`, package files, Dockerfile (`WARN` → rerun `launch.sh`)
- bootstrap token from `.env` accepted by `/api/v1/me`
- dashboard auth state: enrolled passkey count, whether an agent passkey is saved, whether setup/recovery is open

## 4. Drive

### API and public hosts (curl)

```bash
$S/req.sh "$RUN" <name> <METHOD> <path-or-url> [curl args...]
```

`/api/...` paths get the base URL and `Authorization: Bearer <BOOTSTRAP_TOKEN>`. Anything else (`http://{slug}.postplan.localhost:3005/...`) goes out without auth. Every call saves `$RUN/<name>.req|.headers|.body`. A 201 from `POST /api/v1/{drafts,assets,tokens}` is appended to `$RUN/created.tsv` for cleanup. Feature files give the exact calls.

For row-level side effects, `$S/psql.sh "<select ...>" > "$RUN/<name>.sql.txt"`. Read-only queries only: do mutations through the API or UI.

### Dashboard (Playwright MCP)

The dashboard sits behind a passkey. The agent uses its own virtual passkey (Chrome DevTools WebAuthn virtual authenticator), saved in `.verify/auth/passkey.json` (gitignored, mode 600). Skip this section entirely when `scope.sh` lists no dashboard feature.

Never read `.env` secrets or `passkey.json` into your own context. `browser_run_code_unsafe` echoes snippet code into the transcript. So the helpers below write one-shot snippets that fetch the secret or key from a `127.0.0.1` server at runtime (`scripts/oneshot.mjs`, one request, 60 s timeout). Run each generated snippet within 60 s, then delete it.

**Unlock with the saved passkey** (doctor says "saved agent passkey present"):

1. `browser_navigate` → `http://postplan.localhost:3005/unlock`. If it lands on `/` instead, the browser still has a session: skip to driving.
2. `$S/passkey-restore.sh`, then `browser_run_code_unsafe` with `filename: ".verify/auth/restore-passkey.js"` → `{restored: 1}`
3. `browser_click` target `#unlock`. The page redirects to `/` (`h1` "Drafts"). The virtual authenticator answers instantly, with no OS prompt.
4. `rm .verify/auth/restore-passkey.js`

If unlock shows `#unlock-error`, the saved credential is no longer enrolled (doctor will show none or other names). Fall through to enrollment.

**Enroll an agent passkey (no saved passkey, or it stopped working):**

Doctor's last line says which path applies:

- **"first-run setup open"** (fresh or wiped DB): enroll through setup. This is the normal path. The agent owns the local dashboard.
- **"recovery secret unused"**: enroll through recovery. Recovery deletes every enrolled passkey and session. Doctor lists the enrolled names: if all of them are `verify-postplan agent`, go ahead. If any other name is listed, a human enrolled it. Ask the user before recovering, because it removes theirs.
- **"no setup/recovery available"**: the recovery secret is spent. Ask the user to rotate `ADMIN_RECOVERY_SECRET` in `.env`, then rerun `launch.sh`. Until then, verify the API side and report the dashboard part as not driven.

Steps (same for setup and recovery; `<mode>` is `setup` or `recovery`):

1. `browser_navigate` → `http://postplan.localhost:3005/setup`. Expect "Set up PostPlan" or "Recover access", matching doctor.
2. `browser_run_code_unsafe` with `filename: ".agents/skills/verify-postplan/playwright/attach-authenticator.js"`
3. `$S/secret-fill.sh <mode>`, then `browser_run_code_unsafe` with `filename: ".verify/auth/fill-secret.js"` → title "Add your passkey · PostPlan". Then `rm .verify/auth/fill-secret.js`.
4. `browser_run_code_unsafe` with code `async (page) => { await page.locator('#device').fill('verify-postplan agent'); await page.locator('#enroll').click(); await page.waitForURL((u) => !u.pathname.startsWith('/setup')); return page.url(); }`. The name must be exact: doctor and future agents rely on it. Lands on `/`.
5. `$S/passkey-save.sh`, then `browser_run_code_unsafe` with `filename: ".verify/auth/save-passkey.js"` → `{saved: 1}`. That writes `.verify/auth/passkey.json`, replacing any stale file. Then `rm .verify/auth/save-passkey.js`.
6. If you used recovery, say so in the report.

The CDP session lives on the Playwright page. After `browser_close`, or in a new tab, restore again before the next unlock. Session cookies outlive the page, so a later navigation may already be unlocked.

**Driving pages:** prefer form actions and ids from the Eta views over text and coordinates. Nav: `a[href="/"]`, `a[href="/assets"]`, `a[href="/keys"]`, `a[href="/security"]`, `form[action="/lock"] button`. Confirmations come in two kinds. Draft delete uses native `confirm()`: answer with `browser_handle_dialog accept: true`, or inside a `browser_run_code_unsafe` snippet register `page.once('dialog', (d) => d.accept())` before the click. The tool still prints a "Modal state" note; check the result, not the note. Asset delete and token revoke open an in-page `<dialog>`: wait for `#delete-dialog` / `#revoke-dialog`, screenshot it, click its `button[data-confirm]`. Multi-step flows are fastest as one `browser_run_code_unsafe` snippet that returns the observed state as JSON and saves screenshots with `page.screenshot({ path: '<RUN relative to repo>/NN-<what>.png' })`. Never return secret values (e.g. `#new-secret` text) from a snippet: return a shape check instead (`startsWith('pp_')`, length). Every dashboard POST needs the page's `_csrf` hidden input and a matching `Origin`, so submit the real forms. Never hand-craft dashboard POSTs with curl.

## 5. Evidence

Everything goes in `$RUN` (`.verify/runs/<utc>-<label>/`, gitignored, never deleted by cleanup):

- `*.req/.headers/.body` from `req.sh`: the action and the server's answer
- `*.sql.txt` from `psql.sh`: the side effect in Postgres
- screenshots: `browser_take_screenshot` with `filename: "<RUN relative to repo>/NN-<what>.png"`, before and after each UI action, not just the end state
- `meta.txt` (branch, HEAD, dirty count, start/finish), `created.tsv`, `cleanup.log`

For a recording, or network and console capture, use the `agent-browser` CLI (ffmpeg is installed). Use it when a still can't show the behavior (drag-drop upload, a multi-step flow), or when the change is about requests or errors. Pass absolute paths, and use the `verify-postplan` session so you don't disturb other browser sessions:

```bash
export AGENT_BROWSER_SESSION=verify-postplan
R="$(cd "$RUN" && pwd)"
agent-browser open "http://$SLUG.postplan.localhost:3005/"
agent-browser network har start
agent-browser record start "$R/NN-<what>.webm"
#   ...drive: agent-browser click '<selector>', fill, snapshot, screenshot "$R/NN-<what>.png"
agent-browser record stop
agent-browser network har stop "$R/network.har"
agent-browser console > "$R/console.txt"; agent-browser errors > "$R/errors.txt"
agent-browser close
```

agent-browser has no virtual passkey. For dashboard recordings, unlock in Playwright first. Read the session cookie with `browser_run_code_unsafe` code `async (page) => (await page.context().cookies()).find(c => c.name === 'postplan_session').value`. Then, before `open`: `agent-browser cookies set postplan_session '<value>' --url http://postplan.localhost:3005 --httpOnly --sameSite Lax`. Keep the cookie value out of evidence files.

Proof standards:

- Exercise the real user path: the public API with a token, the dashboard through its forms, the public hosts through their URLs. No direct DB writes, no internal service calls.
- Capture the action and the resulting state. Then check the side effect separately: version rows, `status`, Garage bytes, which you check by fetching the Draft or Asset host, not by trusting the API's 201.
- No mocks. Postgres and Garage are real in this stack.
- End with a short report: what was driven, the pass/fail per sub-feature, and the `$RUN` path.

## 6. Cleanup

```bash
$S/cleanup.sh "$RUN"
browser_close   # if you used the dashboard
```

It DELETEs each id in `created.tsv` through the API. Drafts are soft-deleted (`status='deleted'`, 404 publicly); the row stays until purge, which is expected. Record ids of anything you created through the dashboard UI in `created.tsv` yourself (`printf 'draft\t<id>\n' >> "$RUN/created.tsv"`). It deletes any leftover one-shot snippets in `.verify/auth/`. It stops the stack only if `$RUN/started-stack` exists. It never removes volumes, `.verify/auth/passkey.json`, or the run dir. Kill nothing by process name.

After a failed attempt, still run `cleanup.sh` on that run dir before retrying.

## 7. Evidence in a PR

When the task ends in a pull request, put the visual proof in the PR body. Do it before `gh pr create`, so the PR opens with evidence instead of getting it in a later edit. `$RUN` is local and gitignored, and local asset URLs (`assets.postplan.localhost`) don't render on GitHub. So upload with the `asset-upload` skill, which posts to the production Postplan (`$POSTPLAN_URL`, `$POSTPLAN_TOKEN`). If the token is unset, stop and ask the user. Don't commit evidence files to the repo.

1. Pick the evidence that shows the change: before/after screenshots of each UI action, and a recording when the behavior moves. For API-only changes, a short excerpt from `*.req`/`*.body`/`*.headers` in the PR body beats a screenshot of a terminal.
2. Check each file for secrets before uploading: an uploaded Asset is public. Never upload token-secret screenshots (`#new-secret` on `/keys`), anything showing `.env` values, or a HAR/console file that contains cookies or `Authorization` headers.
3. Upload each file per the `asset-upload` skill. Use a `description` that says what the image proves ("Drafts list grouped by verify/postplan after edit"). Record `id` and `url` in `$RUN/uploads.tsv`. `cleanup.sh` does not delete these: the PR links to them.
4. Write the PR body's verification section: the features and sub-features driven with pass/fail, images inline (`![<description>](<url>)`), and recordings as links (GitHub doesn't embed external video), plus the `$RUN` name for reference.

## Helpers

| Script | Use |
|---|---|
| `scope.sh [base]` | changed files → features to verify |
| `new-run.sh <label>` | create and print the run dir |
| `launch.sh <run>` | build, start, wait for ready |
| `doctor.sh` | read-only health and auth check |
| `req.sh <run> <name> <METHOD> <path-or-url> [curl args]` | HTTP call with saved evidence |
| `psql.sh "<sql>"` | read-only query against the stack's Postgres |
| `field.sh <file> <key>` | print one field of a saved JSON body (`ID=$($S/field.sh "$RUN/01-create.body" id)`) |
| `secret-fill.sh setup\|recovery` | generate `.verify/auth/fill-secret.js` (fills `#secret` on `/setup` without exposing it) |
| `passkey-save.sh` | generate `.verify/auth/save-passkey.js` (writes the virtual credential to `passkey.json`) |
| `passkey-restore.sh` | generate `.verify/auth/restore-passkey.js` (re-attaches the saved credential) |
| `oneshot.mjs` | the one-request `127.0.0.1` hop the three generators use; not called directly |
| `cleanup.sh <run>` | delete created resources, stop the stack if this run started it |
| `playwright/attach-authenticator.js` | `browser_run_code_unsafe` filename: add a fresh virtual authenticator |
