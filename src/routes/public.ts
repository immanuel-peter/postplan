import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import {
  CURRENT_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  currentEtag,
  draftCsp,
  versionEtag,
} from "../lib/csp.js";
import { assetOrigin } from "../lib/host.js";
import { getHtml } from "../lib/s3.js";
import { getVersionForPublic } from "../services/drafts.js";

const HTML_TYPE = "text/html; charset=utf-8";

const NOT_FOUND_HTML =
  "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Not found</title></head>\n<body><p>Not found</p></body></html>";

type VersionParams = {
  n: string;
};

function draftHostConstraint(baseDomain: string): RegExp {
  const escaped = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?!assets\\.)[^./]+\\.${escaped}(?::\\d+)?$`, "i");
}

function draftSlug(hostKind: FastifyRequest["hostKind"]): string | null {
  switch (hostKind.kind) {
    case "draft":
      return hostKind.slug;
    case "apex":
    case "assets":
    case "local":
    case "reject":
      return null;
    default: {
      const _exhaustive: never = hostKind;
      return _exhaustive;
    }
  }
}

function parseVersionParam(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  return n;
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

function sendNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).type(HTML_TYPE).send(NOT_FOUND_HTML);
}

function applyDocumentHeaders(
  reply: FastifyReply,
  etag: string,
  cacheControl: string,
  vary: boolean,
  contentSecurityPolicy: string,
): void {
  reply
    .header("Content-Security-Policy", contentSecurityPolicy)
    .header("X-Frame-Options", "DENY")
    .header("Cross-Origin-Opener-Policy", "same-origin")
    .header("ETag", etag)
    .header("Cache-Control", cacheControl);
  if (vary) {
    reply.header("Vary", "Accept-Encoding");
  }
}

async function servePublicHtml(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  slug: string,
  versionNumber: number | undefined,
  contentSecurityPolicy: string,
): Promise<void> {
  const found =
    versionNumber === undefined
      ? await getVersionForPublic(deps.db, slug)
      : await getVersionForPublic(deps.db, slug, versionNumber);
  if (found === null) {
    sendNotFound(reply);
    return;
  }

  const etag =
    versionNumber === undefined
      ? currentEtag(found.draft.id, found.draft.currentVersion)
      : versionEtag(found.version.contentSha256);
  const cacheControl = versionNumber === undefined ? CURRENT_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
  const vary = versionNumber === undefined;

  applyDocumentHeaders(reply, etag, cacheControl, vary, contentSecurityPolicy);
  if (matchesEtag(request.headers["if-none-match"], etag)) {
    reply.code(304).send();
    return;
  }

  const bytes = await getHtml({
    client: deps.s3,
    bucket: deps.config.s3Bucket,
    objectKey: found.version.objectKey,
  });
  reply.code(200).type(HTML_TYPE).send(bytes);
}

export async function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const draftHost = draftHostConstraint(deps.config.baseDomain);
  const draftOnly = { constraints: { host: draftHost } };
  const contentSecurityPolicy = draftCsp(
    assetOrigin({
      baseDomain: deps.config.baseDomain,
      port: deps.config.port,
      nodeEnv: deps.config.nodeEnv,
    }),
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const faviconIco = readFileSync(join(here, "..", "public", "favicon-draft.ico"));
  const faviconSvg = readFileSync(join(here, "..", "public", "favicon-draft.svg"));
  const touchIcon = readFileSync(join(here, "..", "public", "apple-touch-icon-draft.png"));

  app.get("/favicon.ico", draftOnly, async (_request, reply) => {
    return reply
      .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
      .type("image/x-icon")
      .send(faviconIco);
  });
  app.get("/favicon.svg", draftOnly, async (_request, reply) => {
    return reply
      .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
      .type("image/svg+xml")
      .send(faviconSvg);
  });
  app.get("/apple-touch-icon.png", draftOnly, async (_request, reply) => {
    return reply
      .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
      .type("image/png")
      .send(touchIcon);
  });

  app.get("/", draftOnly, async (request, reply) => {
    const slug = draftSlug(request.hostKind);
    if (slug === null) {
      return;
    }
    await servePublicHtml(request, reply, deps, slug, undefined, contentSecurityPolicy);
  });

  app.get<{ Params: VersionParams }>("/v/:n", draftOnly, async (request, reply) => {
    const slug = draftSlug(request.hostKind);
    if (slug === null) {
      return;
    }
    const versionNumber = parseVersionParam(request.params.n);
    if (versionNumber === null) {
      sendNotFound(reply);
      return;
    }
    await servePublicHtml(request, reply, deps, slug, versionNumber, contentSecurityPolicy);
  });

  app.all("/*", draftOnly, async (_request, reply) => {
    sendNotFound(reply);
  });
}
