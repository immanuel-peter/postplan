import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title"),
    description: text("description"),
    status: text("status").notNull().default("active"),
    currentVersion: integer("current_version").notNull(),
    repositoryUrl: text("repository_url"),
    repositoryName: text("repository_name"),
    gitRef: text("git_ref"),
    gitCommit: text("git_commit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("drafts_slug_idx").on(table.slug),
    index("drafts_updated_at_idx").on(table.updatedAt),
    index("drafts_repository_name_idx").on(table.repositoryName),
  ],
);

export const draftVersions = pgTable(
  "draft_versions",
  {
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    gitRef: text("git_ref"),
    gitCommit: text("git_commit"),
    sourceFilename: text("source_filename"),
    securityPolicyVersion: integer("security_policy_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.versionNumber] })],
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("api_tokens_prefix_idx").on(table.prefix)],
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const orphanObjects = pgTable("orphan_objects", {
  objectKey: text("object_key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
