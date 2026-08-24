import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiTokens } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import {
  ALL_SCOPES,
  generateTokenSecret,
  hashesEqual,
  hashToken,
  tokenPrefix,
  type Scope,
} from "../lib/tokens.js";
import type { ServiceError, TokenRecord } from "./types.js";

const LAST_USED_THROTTLE_MS = 60_000;

function toRecord(row: typeof apiTokens.$inferSelect): TokenRecord {
  const scopes: Scope[] = [];
  for (const scope of row.scopes) {
    if (scope === "drafts:read" || scope === "drafts:write" || scope === "drafts:delete" || scope === "tokens:manage") {
      scopes.push(scope);
    }
  }
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

export async function authenticateToken(input: {
  db: Database;
  pepper: string;
  token: string;
}): Promise<TokenRecord | null> {
  const prefix = tokenPrefix(input.token);
  const hash = hashToken(input.token, input.pepper);
  const now = new Date();
  const rows = await input.db
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.prefix, prefix),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
      ),
    );

  let matched: TokenRecord | null = null;
  for (const row of rows) {
    if (hashesEqual(row.secretHash, hash)) {
      matched = toRecord(row);
      const last = row.lastUsedAt?.getTime() ?? 0;
      if (now.getTime() - last > LAST_USED_THROTTLE_MS) {
        await input.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id));
        matched.lastUsedAt = now;
      }
      break;
    }
  }
  return matched;
}

export async function listTokens(db: Database): Promise<TokenRecord[]> {
  const rows = await db.select().from(apiTokens).orderBy(apiTokens.createdAt);
  return rows.filter((row) => row.revokedAt === null).map(toRecord);
}

export async function createToken(input: {
  db: Database;
  pepper: string;
  name: string;
  expiresAt?: Date | null;
}): Promise<{ record: TokenRecord; secret: string }> {
  const secret = generateTokenSecret();
  const now = new Date();
  const record: TokenRecord = {
    id: newId(),
    name: input.name,
    prefix: tokenPrefix(secret),
    scopes: [...ALL_SCOPES],
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
  };

  await input.db.insert(apiTokens).values({
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    secretHash: hashToken(secret, input.pepper),
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: record.createdAt,
  });

  return { record, secret };
}

export async function revokeToken(db: Database, id: string): Promise<TokenRecord | ServiceError> {
  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
  if (!row || row.revokedAt) {
    return { kind: "not_found", title: "Not found", detail: "token not found" };
  }
  const now = new Date();
  await db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, id));
  return toRecord({ ...row, revokedAt: now });
}

export async function tokenCount(db: Database): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(apiTokens);
  return Number(row?.count ?? 0);
}

export async function seedBootstrapToken(input: {
  db: Database;
  pepper: string;
  bootstrapToken: string;
}): Promise<void> {
  const count = await tokenCount(input.db);
  if (count > 0) {
    return;
  }
  if (!input.bootstrapToken.startsWith("pp_")) {
    throw new Error("BOOTSTRAP_TOKEN must start with pp_");
  }
  await input.db.insert(apiTokens).values({
    id: newId(),
    name: "bootstrap",
    prefix: tokenPrefix(input.bootstrapToken),
    secretHash: hashToken(input.bootstrapToken, input.pepper),
    scopes: [...ALL_SCOPES],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
  });
}

export function hasScope(token: TokenRecord, scope: Scope): boolean {
  return token.scopes.includes(scope);
}
