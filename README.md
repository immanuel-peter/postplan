# Postplan

Postplan is a web service for publishing HTML documents. Agents send self-contained HTML files to the API. Each document receives a unique subdomain and an append-only version history.

- Production host: `https://postplan.domain`
- Draft latest version: `https://{slug}.postplan.domain`
- Draft specific version: `https://{slug}.postplan.domain/v/{n}`

## Local development

Start the local stack with Docker Compose:

```bash
docker compose up --build -d
```

Local access points:
- Dashboard: `http://postplan.localhost:3000/`
- Drafts: `http://{slug}.postplan.localhost:3000/`
- API specification: `http://postplan.localhost:3000/openapi.json`
- Default development token: `pp_local_dev_bootstrap`

## Publish

All API endpoints require a bearer token in the HTTP `Authorization` header.

Authentication details:
- Supply tokens as `Authorization: Bearer pp_...`.
- Tokens have full administrative permissions.
- The dashboard displays the secret token value only one time.
- The OpenAPI schema is available at `/openapi.json`.

### Create a draft

Send a `POST` request with multipart form data to create a draft:

```bash
curl "https://postplan.domain/api/v1/drafts" \
  -H "Authorization: Bearer $POSTPLAN_TOKEN" \
  -F "html=@page.html;type=text/html" \
  -F "title=How Transformer Attention Works" \
  -F "repository_url=https://github.com/org/repo" \
  -F "repository_name=org/repo" \
  -F "git_ref=main" \
  -F "git_commit=$(git rev-parse HEAD)"
```

### Add a version

Send a `POST` request to `/api/v1/drafts/{id}/versions` to append a new version:
- Supply the `If-Match: "{version_number}"` header to confirm the target version.
- The server stores the new version as `version_number + 1`.

## Deployment

Deploy the project stack on Hostess with `hostess.yml`.

Services in the stack:
- `app`: Node.js and Fastify application server.
- `database`: Managed PostgreSQL database.
- `garage`: Garage S3 object store for HTML storage.
- `cloudflared`: Cloudflare tunnel for apex and wildcard domains.

Environment and secret settings:
- Set `BASE_DOMAIN` to your apex domain.
- Set `TOKEN_PEPPER` to a fixed secret string. Changing this value invalidates all stored tokens.
- Set `BOOTSTRAP_TOKEN` to a secret value that begins with `pp_`. The system seeds this token only when the token table is empty.
- Configure `CLOUDFLARE_TUNNEL_TOKEN` and the `GARAGE_*` secrets.
