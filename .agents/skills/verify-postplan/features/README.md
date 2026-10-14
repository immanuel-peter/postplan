# Postplan feature map

One file per user-facing feature. Each lists its sub-features, how a user reaches them, the exact harness steps, and gotchas. A proof covers every entry point the file lists for the touched sub-features, not just the most convenient one.

`scripts/scope.sh` turns a diff into the list of files below. Same mapping:

| Changed path | Feature file | Dashboard unlock? |
|---|---|---|
| `src/routes/api.ts` | publish-and-versions, assets, tokens (whichever handlers changed) | no |
| `src/services/drafts.ts`, `src/lib/{multipart,slug,tokens,auth}.ts` | [publish-and-versions](publish-and-versions.md) | no |
| `src/routes/public.ts`, `src/lib/{csp,host,html}.ts` | [public-draft-serving](public-draft-serving.md) | no |
| `src/routes/assets-public.ts`, `src/services/{assets,orphans}.ts`, `src/lib/s3.ts`, `src/views/assets/*` | [assets](assets.md) | for the dashboard sub-features |
| `src/routes/dashboard.ts`, `src/views/drafts/*`, `src/views/layouts/main.eta`, `src/public/app.css` | [dashboard-drafts](dashboard-drafts.md) | yes |
| `src/services/tokens.ts`, `src/views/tokens/*` | [tokens](tokens.md) | for `/keys` |
| `src/routes/auth.ts`, `src/lib/admin-*`, `src/services/admin.ts`, `src/public/webauthn.js`, `src/views/auth/*` | [passkey-auth](passkey-auth.md) | yes; auth is the subject |
| `drizzle/*`, `src/db/*` | doctor's migration check + every feature touching the changed tables | depends |
| `compose.yaml`, `Dockerfile`, `src/{config,server,app}.ts`, `package*.json` | launch + doctor, then publish-and-versions as a smoke | no |

`src/routes/dashboard.ts` also serves `/keys` and `/assets`. Check which handlers the diff touched.
