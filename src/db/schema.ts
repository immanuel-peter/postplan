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

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull().unique(),
    filename: text("filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("assets_created_at_idx").on(t.createdAt)],
);

export const adminSetup = pgTable("admin_setup", {
  id: text("id").primaryKey(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  recoveryConsumedHash: text("recovery_consumed_hash"),
  recoveryConsumedAt: timestamp("recovery_consumed_at", { withTimezone: true }),
});

export const adminCredentials = pgTable(
  "admin_credentials",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports").array().notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("admin_credentials_created_at_idx").on(t.createdAt)],
);

export const adminChallenges = pgTable(
  "admin_challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull(),
    operation: text("operation").notNull(),
    secretHash: text("secret_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("admin_challenges_expires_at_idx").on(t.expiresAt)],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("admin_sessions_expires_at_idx").on(t.expiresAt)],
);
