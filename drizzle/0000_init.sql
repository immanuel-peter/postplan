CREATE TABLE IF NOT EXISTS "drafts" (
  "id" text PRIMARY KEY,
  "slug" text NOT NULL UNIQUE,
  "title" text,
  "description" text,
  "status" text NOT NULL DEFAULT 'active',
  "current_version" integer NOT NULL,
  "repository_url" text,
  "repository_name" text,
  "git_ref" text,
  "git_commit" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  CONSTRAINT "drafts_status_check" CHECK ("status" IN ('active', 'deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "drafts_slug_idx" ON "drafts" ("slug");
CREATE INDEX IF NOT EXISTS "drafts_updated_at_idx" ON "drafts" ("updated_at");
CREATE INDEX IF NOT EXISTS "drafts_repository_name_idx" ON "drafts" ("repository_name");

CREATE TABLE IF NOT EXISTS "draft_versions" (
  "draft_id" text NOT NULL REFERENCES "drafts" ("id"),
  "version_number" integer NOT NULL,
  "object_key" text NOT NULL,
  "content_sha256" text NOT NULL,
  "byte_size" integer NOT NULL,
  "git_ref" text,
  "git_commit" text,
  "source_filename" text,
  "security_policy_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("draft_id", "version_number")
);

CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "secret_hash" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "api_tokens_prefix_idx" ON "api_tokens" ("prefix");

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "key" text PRIMARY KEY,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "orphan_objects" (
  "object_key" text PRIMARY KEY,
  "created_at" timestamptz NOT NULL
);
