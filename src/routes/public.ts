import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import {
  CURRENT_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  documentEtag,
  draftCsp,
} from "../lib/csp.js";
import { sha256Hex } from "../lib/hash.js";
import { assetOrigin } from "../lib/host.js";
import { addLinkPreview, previewFingerprint, previewText } from "../lib/link-preview.js";
import { OG_CARD_REVISION, renderOgCard } from "../lib/og-card.js";
import { getHtml } from "../lib/s3.js";
import { getVersionForPublic } from "../services/drafts.js";
import { matchesEtag, parseVersionNumber } from "../lib/request.js";

const HTML_TYPE = "text/html; charset=utf-8";
const CARD_CACHE_SIZE = 64;

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

  const etag = documentEtag(
    versionNumber === undefined ? `${found.draft.id}-${found.draft.currentVersion}` : found.version.contentSha256,
    previewFingerprint(found.draft),
  );
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
  const pageUrl = deps.urls.publicUrl(slug, versionNumber);
  const html = addLinkPreview(bytes.toString("utf8"), {
    title: found.draft.title,
    description: found.draft.description,
    pageUrl,
    imageUrl: new URL(versionNumber === undefined ? "/og.png" : `/v/${versionNumber}/og.png`, pageUrl).href,
  });
  reply.code(200).type(HTML_TYPE).send(html);
}

async function serveCard(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  cards: Map<string, Buffer>,
  slug: string,
  versionNumber: number | undefined,
): Promise<void> {
  const found = await getVersionForPublic(deps.db, slug, versionNumber);
  if (found === null) {
    sendNotFound(reply);
    return;
  }
  const { draft, version } = found;
  const fingerprint = sha256Hex(
    Buffer.from(
      JSON.stringify([OG_CARD_REVISION, draft.id, version.versionNumber, version.contentSha256, draft.title, draft.description, deps.config.baseDomain]),
    ),
  );
  const etag = `"og-${fingerprint.slice(0, 24)}"`;
  reply
    .header("ETag", etag)
    .header("Cache-Control", CURRENT_CACHE_CONTROL)
    .header("X-Content-Type-Options", "nosniff");
  if (matchesEtag(request.headers["if-none-match"], etag)) {
    reply.code(304).send();
    return;
  }

  let png = cards.get(etag);
  if (png === undefined) {
    const needsDocument = !draft.title?.trim() || !draft.description?.trim();
    const html = needsDocument
      ? (await getHtml({ client: deps.s3, bucket: deps.config.s3Bucket, objectKey: version.objectKey })).toString("utf8")
      : null;
    png = await renderOgCard({
      ...previewText(draft, html),
      slug: draft.slug,
      domain: deps.config.baseDomain,
      version: version.versionNumber,
    });
  }
  cards.delete(etag);
  cards.set(etag, png);
  if (cards.size > CARD_CACHE_SIZE) {
    const oldest = cards.keys().next().value;
    if (oldest !== undefined) {
      cards.delete(oldest);
    }
  }
  reply.code(200).type("image/png").send(png);
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

  const cards = new Map<string, Buffer>();

  app.get("/og.png", draftOnly, async (request, reply) => {
    const slug = draftSlug(request.hostKind);
    if (slug === null) {
      return;
    }
    await serveCard(request, reply, deps, cards, slug, undefined);
  });

  app.get<{ Params: VersionParams }>("/v/:n/og.png", draftOnly, async (request, reply) => {
    const slug = draftSlug(request.hostKind);
    if (slug === null) {
      return;
    }
    const versionNumber = parseVersionNumber(request.params.n);
    if (versionNumber === null) {
      sendNotFound(reply);
      return;
    }
    await serveCard(request, reply, deps, cards, slug, versionNumber);
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
    const versionNumber = parseVersionNumber(request.params.n);
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
