import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { IMMUTABLE_CACHE_CONTROL } from "../lib/csp.js";
import { getBytes } from "../lib/s3.js";
import type { AssetRecord } from "../services/assets.js";
import { getAsset, parseAssetPath } from "../services/assets.js";
import { isServiceError } from "../services/types.js";

type AssetParams = {
  id: string;
};

function assetsHostConstraint(baseDomain: string): RegExp {
  const escaped = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^assets\\.${escaped}(?::\\d+)?$`, "i");
}

function matchesEtag(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) {
    return false;
  }
  const header = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  for (const token of header.split(",")) {
    const candidate = token.trim();
    if (candidate === "*" || candidate === etag) {
      return true;
    }
  }
  return false;
}

function sanitizeFilename(filename: string | null): string {
  if (!filename) {
    return "file";
  }
  const cleaned = filename.replace(/["\r\n]/g, "");
  return cleaned.length > 0 ? cleaned : "file";
}

function parseRangeHeader(
  header: string | string[] | undefined,
  byteSize: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) {
    return null;
  }
  const value = (Array.isArray(header) ? header.join(",") : header).trim();
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) {
    return "unsatisfiable";
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") {
    return "unsatisfiable";
  }
  if (startText === "") {
    const suffix = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || byteSize <= 0) {
      return "unsatisfiable";
    }
    if (suffix >= byteSize) {
      return { start: 0, end: byteSize - 1 };
    }
    return { start: byteSize - suffix, end: byteSize - 1 };
  }
  const start = Number.parseInt(startText, 10);
  if (!Number.isSafeInteger(start) || start < 0 || start >= byteSize) {
    return "unsatisfiable";
  }
  if (endText === "") {
    return { start, end: byteSize - 1 };
  }
  const end = Number.parseInt(endText, 10);
  if (!Number.isSafeInteger(end) || end < start) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, byteSize - 1) };
}

function applyAssetHeaders(
  reply: FastifyReply,
  record: AssetRecord,
  etag: string,
  contentLength: number,
): void {
  reply
    .header("Content-Type", record.contentType)
    .header("Content-Length", String(contentLength))
    .header("Content-Disposition", `inline; filename="${sanitizeFilename(record.filename)}"`)
    .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
    .header("ETag", etag)
    .header("Accept-Ranges", "bytes")
    .header("Access-Control-Allow-Origin", "*")
    .header("Cross-Origin-Resource-Policy", "cross-origin")
    .header("Timing-Allow-Origin", "*");
}

export async function registerAssetPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const assetsHost = assetsHostConstraint(deps.config.baseDomain);
  const assetsOnly = { constraints: { host: assetsHost } };

  app.get<{ Params: AssetParams }>("/:id", assetsOnly, async (request, reply) => {
    if (request.hostKind.kind !== "assets") {
      reply.code(404).type("text/plain").send("not found");
      return;
    }
    const id = parseAssetPath(request.params.id);
    if (id === "") {
      reply.code(404).type("text/plain").send("not found");
      return;
    }
    const record = await getAsset(deps.db, id);
    if (isServiceError(record)) {
      reply.code(404).type("text/plain").send("not found");
      return;
    }

    const etag = `"${record.sha256}"`;
    if (matchesEtag(request.headers["if-none-match"], etag)) {
      reply.header("ETag", etag).header("Cache-Control", IMMUTABLE_CACHE_CONTROL).code(304).send();
      return;
    }

    const range = parseRangeHeader(request.headers.range, record.byteSize);
    if (range === "unsatisfiable") {
      reply
        .header("Content-Range", `bytes */${record.byteSize}`)
        .code(416)
        .type("text/plain")
        .send("range not satisfiable");
      return;
    }
    if (range === null) {
      const result = await getBytes({
        client: deps.s3,
        bucket: deps.config.s3Bucket,
        objectKey: record.objectKey,
      });
      applyAssetHeaders(reply, record, etag, result.bytes.length);
      reply.code(200).send(result.bytes);
      return;
    }
    const result = await getBytes({
      client: deps.s3,
      bucket: deps.config.s3Bucket,
      objectKey: record.objectKey,
      range: `bytes=${range.start}-${range.end}`,
    });
    applyAssetHeaders(reply, record, etag, result.bytes.length);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${record.byteSize}`);
    reply.code(206).send(result.bytes);
  });

  app.all("/*", assetsOnly, async (_request, reply) => {
    reply.code(404).type("text/plain").send("not found");
  });
}
