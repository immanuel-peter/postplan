import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "../db/client.js";
import { draftVersions, drafts, idempotencyKeys } from "../db/schema.js";
import { SECURITY_POLICY_VERSION } from "../lib/csp.js";
import { sha256Hex } from "../lib/hash.js";
import { isHtmlValidationError, validateHtml } from "../lib/html.js";
import { localDraftUrl, publicDraftUrl } from "../lib/host.js";
import { newId } from "../lib/ids.js";
import { versionObjectKey, putHtml } from "../lib/s3.js";
import { generateSlug, isReservedSlug } from "../lib/slug.js";
import { recordOrphan } from "./orphans.js";
import type { DraftRecord, DraftResponse, DraftStatus, ServiceError, VersionRecord } from "./types.js";

export type DraftUrls = {
  publicUrl: (slug: string, version?: number) => string;
};

export function draftUrls(input: { baseDomain: string; port: number; nodeEnv: string }): DraftUrls {
  if (input.nodeEnv === "development" || input.baseDomain.endsWith(".localhost")) {
    return {
      publicUrl: (slug, version) => localDraftUrl(slug, input.port, version),
    };
  }
  return {
    publicUrl: (slug, version) => publicDraftUrl(input.baseDomain, slug, version),
  };
}

function asDraft(row: typeof drafts.$inferSelect): DraftRecord {
  const status: DraftStatus = row.status === "deleted" ? "deleted" : "active";
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status,
    currentVersion: row.currentVersion,
    repositoryUrl: row.repositoryUrl,
    repositoryName: row.repositoryName,
    gitRef: row.gitRef,
    gitCommit: row.gitCommit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function asVersion(row: typeof draftVersions.$inferSelect): VersionRecord {
  return {
    draftId: row.draftId,
    versionNumber: row.versionNumber,
    objectKey: row.objectKey,
    contentSha256: row.contentSha256,
    byteSize: row.byteSize,
    gitRef: row.gitRef,
    gitCommit: row.gitCommit,
    sourceFilename: row.sourceFilename,
    securityPolicyVersion: row.securityPolicyVersion,
    createdAt: row.createdAt,
  };
}

export function toDraftResponse(input: {
  draft: DraftRecord;
  version: VersionRecord;
  urls: DraftUrls;
}): DraftResponse {
  return {
    id: input.draft.id,
    slug: input.draft.slug,
    title: input.draft.title,
    description: input.draft.description,
    status: input.draft.status,
    currentVersion: input.draft.currentVersion,
    publicUrl: input.urls.publicUrl(input.draft.slug),
    versionUrl: input.urls.publicUrl(input.draft.slug, input.version.versionNumber),
    contentSha256: input.version.contentSha256,
    byteSize: input.version.byteSize,
    repositoryUrl: input.draft.repositoryUrl,
    repositoryName: input.draft.repositoryName,
    gitRef: input.version.gitRef ?? input.draft.gitRef,
    gitCommit: input.version.gitCommit ?? input.draft.gitCommit,
    createdAt: input.draft.createdAt.toISOString(),
    updatedAt: input.draft.updatedAt.toISOString(),
  };
}

async function uniqueSlug(db: Database): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slug = generateSlug();
    if (isReservedSlug(slug)) {
      continue;
    }
    const [existing] = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.slug, slug)).limit(1);
    if (!existing) {
      return slug;
    }
  }
  throw new Error("failed to allocate slug");
}

export async function getIdempotentResult(input: {
  db: Database;
  key: string;
  requestHash: string;
}): Promise<{ hit: DraftResponse } | { replayConflict: true } | { miss: true }> {
  const [row] = await input.db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, input.key))
    .limit(1);
  if (!row) {
    return { miss: true };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return { miss: true };
  }
  if (row.requestHash !== input.requestHash) {
    return { replayConflict: true };
  }
  return { hit: row.result as DraftResponse };
}

export async function storeIdempotentResult(input: {
  db: Database;
  key: string;
  requestHash: string;
  result: DraftResponse;
}): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await input.db
    .insert(idempotencyKeys)
    .values({
      key: input.key,
      requestHash: input.requestHash,
      result: input.result,
      createdAt: now,
      expiresAt,
    })
    .onConflictDoNothing();
}

export function requestHash(parts: string[]): string {
  return sha256Hex(Buffer.from(parts.join("\n"), "utf8"));
}

export async function createDraft(input: {
  db: Database;
  s3: S3Client;
  bucket: string;
  urls: DraftUrls;
  html: Buffer;
  title?: string | null;
  description?: string | null;
  repositoryUrl?: string | null;
  repositoryName?: string | null;
  gitRef?: string | null;
  gitCommit?: string | null;
  sourceFilename?: string | null;
}): Promise<{ draft: DraftRecord; version: VersionRecord } | ServiceError> {
  const valid = validateHtml(input.html);
  if (isHtmlValidationError(valid)) {
    return { kind: "validation", title: valid.title, detail: valid.detail };
  }

  const now = new Date();
  const id = newId();
  const slug = await uniqueSlug(input.db);
  const objectKey = versionObjectKey(id, 1);

  await putHtml({ client: input.s3, bucket: input.bucket, objectKey, bytes: valid.bytes });

  try {
    await input.db.transaction(async (tx) => {
      await tx.insert(drafts).values({
        id,
        slug,
        title: input.title ?? null,
        description: input.description ?? null,
        status: "active",
        currentVersion: 1,
        repositoryUrl: input.repositoryUrl ?? null,
        repositoryName: input.repositoryName ?? null,
        gitRef: input.gitRef ?? null,
        gitCommit: input.gitCommit ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await tx.insert(draftVersions).values({
        draftId: id,
        versionNumber: 1,
        objectKey,
        contentSha256: valid.sha256,
        byteSize: valid.byteSize,
        gitRef: input.gitRef ?? null,
        gitCommit: input.gitCommit ?? null,
        sourceFilename: input.sourceFilename ?? null,
        securityPolicyVersion: SECURITY_POLICY_VERSION,
        createdAt: now,
      });
    });
  } catch (error) {
    await recordOrphan(input.db, objectKey);
    throw error;
  }

  return {
    draft: {
      id,
      slug,
      title: input.title ?? null,
      description: input.description ?? null,
      status: "active",
      currentVersion: 1,
      repositoryUrl: input.repositoryUrl ?? null,
      repositoryName: input.repositoryName ?? null,
      gitRef: input.gitRef ?? null,
      gitCommit: input.gitCommit ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    version: {
      draftId: id,
      versionNumber: 1,
      objectKey,
      contentSha256: valid.sha256,
      byteSize: valid.byteSize,
      gitRef: input.gitRef ?? null,
      gitCommit: input.gitCommit ?? null,
      sourceFilename: input.sourceFilename ?? null,
      securityPolicyVersion: SECURITY_POLICY_VERSION,
      createdAt: now,
    },
  };
}

export async function addVersion(input: {
  db: Database;
  s3: S3Client;
  bucket: string;
  draftId: string;
  expectedVersion: number;
  html: Buffer;
  gitRef?: string | null;
  gitCommit?: string | null;
  sourceFilename?: string | null;
}): Promise<{ draft: DraftRecord; version: VersionRecord } | ServiceError> {
  const valid = validateHtml(input.html);
  if (isHtmlValidationError(valid)) {
    return { kind: "validation", title: valid.title, detail: valid.detail };
  }

  const [existing] = await input.db.select().from(drafts).where(eq(drafts.id, input.draftId)).limit(1);
  if (!existing || existing.status === "deleted") {
    return { kind: "not_found", title: "Not found", detail: "draft not found" };
  }

  const next = existing.currentVersion + 1;
  const objectKey = versionObjectKey(input.draftId, next);
  await putHtml({ client: input.s3, bucket: input.bucket, objectKey, bytes: valid.bytes });

  try {
    const result = await input.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(drafts)
        .where(eq(drafts.id, input.draftId))
        .for("update")
        .limit(1);
      if (!row || row.status === "deleted") {
        return { kind: "not_found" as const, title: "Not found", detail: "draft not found" };
      }
      if (row.currentVersion !== input.expectedVersion) {
        return {
          kind: "precondition" as const,
          title: "Version conflict",
          detail: "If-Match does not match current Version",
          currentVersion: row.currentVersion,
        };
      }

      const now = new Date();
      const versionNumber = row.currentVersion + 1;
      await tx.insert(draftVersions).values({
        draftId: input.draftId,
        versionNumber,
        objectKey,
        contentSha256: valid.sha256,
        byteSize: valid.byteSize,
        gitRef: input.gitRef ?? null,
        gitCommit: input.gitCommit ?? null,
        sourceFilename: input.sourceFilename ?? null,
        securityPolicyVersion: SECURITY_POLICY_VERSION,
        createdAt: now,
      });
      const [updated] = await tx
        .update(drafts)
        .set({
          currentVersion: versionNumber,
          gitRef: input.gitRef ?? row.gitRef,
          gitCommit: input.gitCommit ?? row.gitCommit,
          updatedAt: now,
        })
        .where(eq(drafts.id, input.draftId))
        .returning();
      if (!updated) {
        return { kind: "not_found" as const, title: "Not found", detail: "draft not found" };
      }
      return {
        draft: asDraft(updated),
        version: {
          draftId: input.draftId,
          versionNumber,
          objectKey,
          contentSha256: valid.sha256,
          byteSize: valid.byteSize,
          gitRef: input.gitRef ?? null,
          gitCommit: input.gitCommit ?? null,
          sourceFilename: input.sourceFilename ?? null,
          securityPolicyVersion: SECURITY_POLICY_VERSION,
          createdAt: now,
        },
      };
    });
    return result;
  } catch (error) {
    await recordOrphan(input.db, objectKey);
    throw error;
  }
}

export async function listDrafts(input: {
  db: Database;
  status?: DraftStatus;
  repository?: string;
  cursor?: string;
  limit: number;
}): Promise<{ items: DraftRecord[]; nextCursor: string | null }> {
  const status = input.status ?? "active";
  const conditions = [eq(drafts.status, status)];
  if (status === "active") {
    conditions.push(isNull(drafts.deletedAt));
  }
  if (input.repository === "") {
    conditions.push(sql`${drafts.repositoryName} IS NULL`);
  } else if (input.repository) {
    conditions.push(eq(drafts.repositoryName, input.repository));
  }
  if (input.cursor) {
    conditions.push(lt(drafts.updatedAt, new Date(input.cursor)));
  }

  const rows = await input.db
    .select()
    .from(drafts)
    .where(and(...conditions))
    .orderBy(desc(drafts.updatedAt))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const extra = rows[input.limit];
  return {
    items: page.map(asDraft),
    nextCursor: extra ? page[page.length - 1]?.updatedAt.toISOString() ?? null : null,
  };
}

export async function getDraft(db: Database, id: string): Promise<DraftRecord | ServiceError> {
  const [row] = await db.select().from(drafts).where(eq(drafts.id, id)).limit(1);
  if (!row || row.status === "deleted") {
    return { kind: "not_found", title: "Not found", detail: "draft not found" };
  }
  return asDraft(row);
}

export async function getDraftBySlug(db: Database, slug: string): Promise<DraftRecord | null> {
  const [row] = await db.select().from(drafts).where(eq(drafts.slug, slug)).limit(1);
  if (!row || row.status === "deleted") {
    return null;
  }
  return asDraft(row);
}

export async function patchDraft(input: {
  db: Database;
  id: string;
  title?: string | null;
  description?: string | null;
  repositoryUrl?: string | null;
  repositoryName?: string | null;
  gitRef?: string | null;
  gitCommit?: string | null;
}): Promise<DraftRecord | ServiceError> {
  const existing = await getDraft(input.db, input.id);
  if ("kind" in existing) {
    return existing;
  }
  const [updated] = await input.db
    .update(drafts)
    .set({
      title: input.title === undefined ? existing.title : input.title,
      description: input.description === undefined ? existing.description : input.description,
      repositoryUrl: input.repositoryUrl === undefined ? existing.repositoryUrl : input.repositoryUrl,
      repositoryName: input.repositoryName === undefined ? existing.repositoryName : input.repositoryName,
      gitRef: input.gitRef === undefined ? existing.gitRef : input.gitRef,
      gitCommit: input.gitCommit === undefined ? existing.gitCommit : input.gitCommit,
      updatedAt: new Date(),
    })
    .where(eq(drafts.id, input.id))
    .returning();
  if (!updated) {
    return { kind: "not_found", title: "Not found", detail: "draft not found" };
  }
  return asDraft(updated);
}

export async function deleteDraft(db: Database, id: string): Promise<DraftRecord | ServiceError> {
  const existing = await getDraft(db, id);
  if ("kind" in existing) {
    return existing;
  }
  const now = new Date();
  const [updated] = await db
    .update(drafts)
    .set({ status: "deleted", deletedAt: now, updatedAt: now })
    .where(eq(drafts.id, id))
    .returning();
  if (!updated) {
    return { kind: "not_found", title: "Not found", detail: "draft not found" };
  }
  return asDraft(updated);
}

export async function listVersions(db: Database, draftId: string): Promise<VersionRecord[] | ServiceError> {
  const draft = await getDraft(db, draftId);
  if ("kind" in draft) {
    return draft;
  }
  const rows = await db
    .select()
    .from(draftVersions)
    .where(eq(draftVersions.draftId, draftId))
    .orderBy(desc(draftVersions.versionNumber));
  return rows.map(asVersion);
}

export async function getVersion(
  db: Database,
  draftId: string,
  versionNumber: number,
): Promise<VersionRecord | ServiceError> {
  const draft = await getDraft(db, draftId);
  if ("kind" in draft) {
    return draft;
  }
  const [row] = await db
    .select()
    .from(draftVersions)
    .where(and(eq(draftVersions.draftId, draftId), eq(draftVersions.versionNumber, versionNumber)))
    .limit(1);
  if (!row) {
    return { kind: "not_found", title: "Not found", detail: "version not found" };
  }
  return asVersion(row);
}

export async function getVersionForPublic(
  db: Database,
  slug: string,
  versionNumber?: number,
): Promise<{ draft: DraftRecord; version: VersionRecord } | null> {
  const draft = await getDraftBySlug(db, slug);
  if (!draft) {
    return null;
  }
  const number = versionNumber ?? draft.currentVersion;
  const [row] = await db
    .select()
    .from(draftVersions)
    .where(and(eq(draftVersions.draftId, draft.id), eq(draftVersions.versionNumber, number)))
    .limit(1);
  if (!row) {
    return null;
  }
  return { draft, version: asVersion(row) };
}

export async function latestVersion(db: Database, draftId: string): Promise<VersionRecord | null> {
  const [row] = await db
    .select()
    .from(draftVersions)
    .where(eq(draftVersions.draftId, draftId))
    .orderBy(desc(draftVersions.versionNumber))
    .limit(1);
  return row ? asVersion(row) : null;
}
