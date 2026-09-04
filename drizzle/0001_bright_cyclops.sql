CREATE TABLE IF NOT EXISTS "assets" (
  "id" text PRIMARY KEY,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "object_key" text NOT NULL UNIQUE,
  "filename" text,
  "created_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "assets_created_at_idx" ON "assets" ("created_at");
