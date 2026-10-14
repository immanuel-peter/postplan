# Postplan

Single-tenant, self-hosted HTML publishing: a Fastify app that serves self-contained HTML Drafts on wildcard subdomains. Language and decision records: `CONTEXT.md`, `docs/adr/`.

## Architecture

- Production: dashboard at `https://postplan.link`, Drafts at `https://{slug}.postplan.link`.
- One app serves both host classes by host dispatch; deployed on Hostess (app, managed Postgres, private Garage S3, cloudflared tunnel — roster and config in `hostess.yml`).
- Drafts hold append-only, gap-free Versions; a publish always creates the next number. Status is `active` (publicly served) or `deleted` (soft-deleted).
- Dashboard is Eta SSR on the apex only, behind one passkey identity, no owner table (ADR 0002, ADR 0008). Draft hosts serve public HTML only, with a CSP that allows inline CSS/JS, images/media from the assets host, and `connect-src *` (ADR 0003).
- API at `/api/v1` — live contract at `https://postplan.link/openapi.json`, `Authorization: Bearer pp_…` tokens.

Product rules:

- Draft titles on the drafts list open the slug host root (which serves the latest public Version), not a pinned `/v/{n}` and not the dashboard detail page; Details stays on the dashboard.
- Repository name/URL, git ref, and git commit are set atomically via the API — never dashboard edit fields.
- Tokens are master keys: no granular scope or permission pickers in the dashboard.

UI taste: light theme, warm off-white `#f6f5f2`, IBM Plex Sans/Mono; no dark mode. The only login chrome is the passkey unlock/setup gate — no email, password, or signup anywhere. Inspiration in `images/`.

TypeScript: NodeNext + `verbatimModuleSyntax` — local imports use `.js` extensions.

## Local dev

- `docker compose up --build -d`: Starts the entire stack and runs migrations (ALWAYS DEFAULT)
- `docker compose down -v`: Clean the local stack.
- The app won't boot without the S3 vars — Garage is not optional.
- Dashboard: `http://postplan.localhost:3005`. Drafts: `http://{slug}.postplan.localhost:3005`. Assets: `http://assets.postplan.localhost:3005`. `*.postplan.localhost` resolves to loopback on macOS.
- Local API token: `BOOTSTRAP_TOKEN` from `.env` (`pp_local_dev_bootstrap` in `.env.example`).
- Dashboard unlock: first run needs `ADMIN_SETUP_SECRET` from `.env`; enter it at `/setup` and enroll a passkey. `ADMIN_RECOVERY_SECRET` authorizes one replacement enrollment — rotate it to use it again.
- Verify: `npm run typecheck` is the only automated gate (no test suite). Then use the `verify-postplan` skill (`.agents/skills/verify-postplan/`) to drive the changed features on the local stack and capture evidence. When the work ends in a PR, upload that evidence and embed it in the PR body before opening it (skill section 7). Schema changes: `npm run db:generate`, `npm run db:migrate:dev`.
