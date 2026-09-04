import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../app.js";
import { ASSET_DOCUMENT_CSP, CURRENT_CACHE_CONTROL } from "../lib/csp.js";
import { getObjectStream } from "../lib/s3.js";
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

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(filename: string | null): string {
  const original = filename && filename.length > 0 ? filename : "file";
  let ascii = "";
  let hasNonAscii = false;
  for (const char of original) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === "\\" || char === "\r" || char === "\n") {
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      ascii += char;
      continue;
    }
    if (code > 0x7e) {
      hasNonAscii = true;
    }
    ascii += "_";
  }
  if (ascii.length === 0) {
    ascii = "file";
  }
  if (!hasNonAscii) {
    return `inline; filename="${ascii}"`;
  }
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(original)}`;
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
    .header("Content-Disposition", contentDisposition(record.filename))
    .header("Cache-Control", CURRENT_CACHE_CONTROL)
    .header("ETag", etag)
    .header("Accept-Ranges", "bytes")
    .header("Access-Control-Allow-Origin", "*")
    .header("Cross-Origin-Resource-Policy", "cross-origin")
    .header("Timing-Allow-Origin", "*")
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", ASSET_DOCUMENT_CSP);
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
      reply.header("ETag", etag).header("Cache-Control", CURRENT_CACHE_CONTROL).code(304).send();
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
      const result = await getObjectStream({
        client: deps.s3,
        bucket: deps.config.s3Bucket,
        objectKey: record.objectKey,
      });
      applyAssetHeaders(reply, record, etag, result.contentLength);
      return reply.code(200).send(result.body);
    }
    const result = await getObjectStream({
      client: deps.s3,
      bucket: deps.config.s3Bucket,
      objectKey: record.objectKey,
      range: `bytes=${range.start}-${range.end}`,
    });
    applyAssetHeaders(reply, record, etag, result.contentLength);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${record.byteSize}`);
    return reply.code(206).send(result.body);
  });

  app.all("/*", assetsOnly, async (_request, reply) => {
    reply.code(404).type("text/plain").send("not found");
  });
}
