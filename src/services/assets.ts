import { and, desc, eq, lt } from "drizzle-orm";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Database } from "../db/client.js";
import { assets } from "../db/schema.js";
import { sha256Hex } from "../lib/hash.js";
import { localAssetUrl, publicAssetUrl } from "../lib/host.js";
import { newId } from "../lib/ids.js";
import { assetObjectKey, deleteObject, putBytes } from "../lib/s3.js";
import { recordOrphan } from "./orphans.js";
import type { ServiceError } from "./types.js";

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export type AssetRecord = {
  id: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  objectKey: string;
  filename: string | null;
  createdAt: Date;
};

export type AssetResponse = {
  id: string;
  url: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  filename: string | null;
  createdAt: string;
};

export type AssetUrls = {
  publicUrl: (id: string, filename?: string | null | undefined) => string;
};

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  txt: "text/plain",
  css: "text/css",
};

const BLOCKED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
]);

const BLOCKED_EXTENSIONS = new Set(["html", "htm", "js", "mjs", "cjs", "xhtml"]);

function executableWebContentError(
  contentType: string,
  filename: string | null,
): ServiceError | null {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = extensionOf(filename);
  if (BLOCKED_CONTENT_TYPES.has(base) || (ext !== undefined && BLOCKED_EXTENSIONS.has(ext))) {
    return {
      kind: "validation",
      title: "Invalid asset",
      detail: "HTML and JavaScript files are not allowed",
    };
  }
  return null;
}

export function extensionOf(filename: string | null): string | undefined {
  if (!filename) {
    return undefined;
  }
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) {
    return undefined;
  }
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : undefined;
}

export function assetUrls(input: { baseDomain: string; port: number; nodeEnv: string }): AssetUrls {
  if (input.nodeEnv === "development" || input.baseDomain.endsWith(".localhost")) {
    return {
      publicUrl: (id, filename) => localAssetUrl(input.port, id, extensionOf(filename ?? null)),
    };
  }
  return {
    publicUrl: (id, filename) => publicAssetUrl(input.baseDomain, id, extensionOf(filename ?? null)),
  };
}

export function contentTypeForUpload(mimetype: string | undefined, filename: string | null): string {
  if (mimetype) {
    const base = mimetype.split(";")[0]?.trim() ?? "";
    if (/^[^\s/]+\/[^\s;]+$/.test(base)) {
      return base;
    }
  }
  const ext = extensionOf(filename);
  if (ext) {
    const guessed = EXTENSION_CONTENT_TYPES[ext];
    if (guessed) {
      return guessed;
    }
  }
  return "application/octet-stream";
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const kb = n / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function parseAssetPath(raw: string): string {
  const stripped = raw.replace(/^\/+/, "");
  if (!stripped) {
    return "";
  }
  const segment = stripped.split("/")[0] ?? "";
  if (!segment) {
    return "";
  }
  const dot = segment.indexOf(".");
  return dot === -1 ? segment : segment.slice(0, dot);
}

function asAsset(row: typeof assets.$inferSelect): AssetRecord {
  return {
    id: row.id,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    objectKey: row.objectKey,
    filename: row.filename,
    createdAt: row.createdAt,
  };
}

export function toAssetResponse(record: AssetRecord, urls: AssetUrls): AssetResponse {
  return {
    id: record.id,
    url: urls.publicUrl(record.id, record.filename),
    contentType: record.contentType,
    byteSize: record.byteSize,
    sha256: record.sha256,
    filename: record.filename,
    createdAt: record.createdAt.toISOString(),
  };
}

export async function createAsset(input: {
  db: Database;
  s3: S3Client;
  bucket: string;
  urls: AssetUrls;
  bytes: Buffer;
  filename: string | null;
  contentType: string;
}): Promise<AssetRecord | ServiceError> {
  if (input.bytes.byteLength === 0) {
    return { kind: "validation", title: "Invalid asset", detail: "asset file is empty" };
  }
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    return {
      kind: "validation",
      title: "Payload too large",
      detail: `asset exceeds ${MAX_ASSET_BYTES} bytes`,
    };
  }

  const blocked = executableWebContentError(input.contentType, input.filename);
  if (blocked) {
    return blocked;
  }

  const now = new Date();
  const id = newId();
  const objectKey = assetObjectKey(id, input.filename);

  await putBytes({
    client: input.s3,
    bucket: input.bucket,
    objectKey,
    bytes: input.bytes,
    contentType: input.contentType,
  });

  const record: AssetRecord = {
    id,
    contentType: input.contentType,
    byteSize: input.bytes.byteLength,
    sha256: sha256Hex(input.bytes),
    objectKey,
    filename: input.filename,
    createdAt: now,
  };

  try {
    await input.db.insert(assets).values({
      id,
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      sha256: record.sha256,
      objectKey,
      filename: input.filename,
      createdAt: now,
    });
  } catch (error) {
    await recordOrphan(input.db, objectKey);
    throw error;
  }

  return record;
}

export async function getAsset(db: Database, id: string): Promise<AssetRecord | ServiceError> {
  if (!id) {
    return { kind: "not_found", title: "Not found", detail: "asset not found" };
  }
  const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!row) {
    return { kind: "not_found", title: "Not found", detail: "asset not found" };
  }
  return asAsset(row);
}

export async function listAssets(input: {
  db: Database;
  limit: number;
  cursor?: string | undefined;
}): Promise<{ items: AssetRecord[]; nextCursor: string | null } | ServiceError> {
  if (input.cursor !== undefined && Number.isNaN(Date.parse(input.cursor))) {
    return {
      kind: "validation",
      title: "Bad Request",
      detail: "cursor must be an ISO-8601 timestamp",
    };
  }
  const cursorFilter = input.cursor ? lt(assets.createdAt, new Date(input.cursor)) : undefined;
  const rows = await input.db
    .select()
    .from(assets)
    .where(cursorFilter !== undefined ? and(cursorFilter) : undefined)
    .orderBy(desc(assets.createdAt))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const extra = rows[input.limit];
  return {
    items: page.map(asAsset),
    nextCursor: extra ? (page[page.length - 1]?.createdAt.toISOString() ?? null) : null,
  };
}

export async function deleteAsset(input: {
  db: Database;
  s3: S3Client;
  bucket: string;
  id: string;
}): Promise<AssetRecord | ServiceError> {
  const existing = await getAsset(input.db, input.id);
  if ("kind" in existing) {
    return existing;
  }
  try {
    await deleteObject({ client: input.s3, bucket: input.bucket, objectKey: existing.objectKey });
  } catch {
    await recordOrphan(input.db, existing.objectKey);
  }
  await input.db.delete(assets).where(eq(assets.id, input.id));
  return existing;
}
