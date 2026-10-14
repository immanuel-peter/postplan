import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { dashboardHostConstraint, isDashboardHostKind } from "../lib/host.js";
import { formatStamp, isoStamp, shortCommit } from "../lib/time.js";
import { hashesEqual } from "../lib/tokens.js";
import {
  deleteDraft,
  getDraft,
  listDrafts,
  listVersions,
  patchDraft,
  setDraftFavorite,
  type DraftUrls,
} from "../services/drafts.js";
import {
  contentTypeForUpload,
  createAsset,
  deleteAsset,
  formatBytes,
  getAsset,
  getAssetNeighbors,
  listAssets,
  MAX_ASSET_BYTES,
  normalizeAssetDescription,
  patchAsset,
  type AssetRecord,
} from "../services/assets.js";
import { createToken, listTokens, revokeToken } from "../services/tokens.js";
import type { DraftRecord, VersionRecord } from "../services/types.js";
import { isServiceError } from "../services/types.js";
import { readField } from "../lib/request.js";

type IdParams = {
  id: string;
};

type DraftListShow = "all" | "favorites";

type DraftListRow = {
  id: string;
  title: string;
  publicUrl: string;
  description: string;
  favorite: boolean;
  versionLabel: string;
  updatedLabel: string;
  updatedIso: string;
  detailUrl: string;
  /** Only set for http(s) URLs, so the template never links anything else. */
  repositoryUrl: string | null;
  repoOwner: string;
  repoName: string;
  /** `owner/name`, or just the name when there is no owner; "" when the Draft has no repository. */
  repoLabel: string;
  isGithub: boolean;
  /** Tints the row: favorites pinned above the rest in the "all" view. */
  isFavorite: boolean;
  /** First non-favorite row under the pinned favorites in the "all" view; draws a stronger rule. */
  afterFavorites: boolean;
};

type DraftList = {
  rows: DraftListRow[];
  totalCount: number;
  favoriteCount: number;
};

type VersionRow = {
  versionLabel: string;
  versionUrl: string;
  commitLabel: string;
  dirty: boolean;
  refLabel: string;
  publishedLabel: string;
  publishedIso: string;
};

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  createdLabel: string;
  createdIso: string;
  lastUsedLabel: string;
  lastUsedIso: string;
};

type AssetItemRow = {
  id: string;
  filename: string;
  description: string | null;
  detailUrl: string;
  thumbUrl: string;
  sizeLabel: string;
  kind: "image" | "video" | "audio" | "pdf" | "other";
  extLabel: string;
  uploadedLabel: string;
  uploadedIso: string;
};

const LIST_PAGE = 100;
const DASH_ASSET_PAGE = 100;
const DASH_ASSET_CAP = 2000;

function isDashboardHost(request: FastifyRequest): boolean {
  return isDashboardHostKind(request.hostKind.kind);
}

function draftTitle(title: string | null): string {
  const trimmed = title?.trim() ?? "";
  return trimmed === "" ? "Untitled draft" : trimmed;
}

function fileCountLabel(count: number): string {
  return count === 1 ? "1 file" : `${String(count)} files`;
}

function refLabel(gitRef: string | null, gitCommit: string | null): string {
  const ref = gitRef?.trim() ?? "";
  const commit = shortCommit(gitCommit);
  if (ref !== "" && commit !== "") {
    return `${ref} ${commit}`;
  }
  if (ref !== "") {
    return ref;
  }
  if (commit !== "") {
    return commit;
  }
  return "—";
}

function parseShow(value: unknown): DraftListShow {
  return value === "favorites" ? "favorites" : "all";
}

function httpUrl(value: string | null): URL | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

type RepoFields = Pick<DraftListRow, "repositoryUrl" | "repoOwner" | "repoName" | "repoLabel" | "isGithub">;

/**
 * Splits the repository into owner and name for display. The stored name wins; without one, the
 * URL path stands in (`https://github.com/owner/name.git` → `owner` / `name`). Anything up to the
 * last "/" is the owner, so a nested GitLab path keeps its groups in the owner part.
 */
function repoFields(draft: DraftRecord): RepoFields {
  const url = httpUrl(draft.repositoryUrl);
  const fromName = draft.repositoryName?.trim() ?? "";
  const source = fromName !== "" ? fromName : (url?.pathname.replace(/\.git$/, "") ?? "");
  const path = source.replace(/^\/+|\/+$/g, "") || (url?.host ?? "");
  const slash = path.lastIndexOf("/");
  const repoOwner = slash === -1 ? "" : path.slice(0, slash);
  const repoName = slash === -1 ? path : path.slice(slash + 1);
  return {
    repositoryUrl: url ? (draft.repositoryUrl?.trim() ?? null) : null,
    repoOwner,
    repoName,
    repoLabel: repoOwner === "" ? repoName : `${repoOwner}/${repoName}`,
    isGithub: url !== null && (url.hostname === "github.com" || url.hostname === "www.github.com"),
  };
}

function toListRow(
  draft: DraftRecord,
  urls: DraftUrls,
  flags: Pick<DraftListRow, "isFavorite" | "afterFavorites">,
): DraftListRow {
  return {
    id: draft.id,
    title: draftTitle(draft.title),
    publicUrl: urls.publicUrl(draft.slug),
    description: draft.description?.trim() ?? "",
    favorite: draft.favorite,
    versionLabel: `v${String(draft.currentVersion)}`,
    updatedLabel: formatStamp(draft.updatedAt),
    updatedIso: isoStamp(draft.updatedAt),
    detailUrl: `/drafts/${draft.id}`,
    ...repoFields(draft),
    ...flags,
  };
}

/** One flat list: favorites pinned on top, then everything else, each newest-updated first. */
function buildDraftList(drafts: DraftRecord[], urls: DraftUrls, show: DraftListShow): DraftList {
  const ordered = [...drafts].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  const favoriteCount = ordered.filter((draft) => draft.favorite).length;
  const visible = show === "favorites" ? ordered.filter((draft) => draft.favorite) : ordered;
  return {
    rows: visible.map((draft, index) =>
      toListRow(draft, urls, {
        isFavorite: show === "all" && draft.favorite,
        afterFavorites: show === "all" && favoriteCount > 0 && index === favoriteCount,
      }),
    ),
    totalCount: drafts.length,
    favoriteCount,
  };
}

function toVersionRow(version: VersionRecord, versionUrl: string): VersionRow {
  const commit = shortCommit(version.gitCommit);
  const dirty = version.gitCommit === null || version.gitCommit.trim() === "";
  return {
    versionLabel: `v${String(version.versionNumber)}`,
    versionUrl,
    commitLabel: dirty ? "—" : commit,
    dirty,
    refLabel: refLabel(version.gitRef, version.gitCommit),
    publishedLabel: formatStamp(version.createdAt),
    publishedIso: isoStamp(version.createdAt),
  };
}

function assetKindFromContentType(contentType: string): AssetItemRow["kind"] {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("image/")) {
    return "image";
  }
  if (ct.startsWith("video/")) {
    return "video";
  }
  if (ct.startsWith("audio/")) {
    return "audio";
  }
  if (ct === "application/pdf") {
    return "pdf";
  }
  return "other";
}

function assetExtLabel(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot + 1).toUpperCase();
}

function assetDisplayName(filename: string | null | undefined): string {
  const trimmed = filename?.trim() ?? "";
  return trimmed === "" ? "unnamed" : trimmed;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// Both the initial page and inline description saves use these references.
function assetReferenceData(asset: AssetRecord, url: string) {
  const filename = assetDisplayName(asset.filename);
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const altSource = asset.description?.trim() || base;
  const kind = assetKindFromContentType(asset.contentType);
  const label = escapeHtml(altSource);
  const src = escapeHtml(url);
  const markdownLabel = altSource.replace(/[\\`*_[\]<>&]/g, "\\$&");
  let html: string;
  if (kind === "image") {
    html = `<img src="${src}" alt="${label}">`;
  } else if (kind === "video" || kind === "audio") {
    html = `<${kind} controls src="${src}" title="${label}"></${kind}>`;
  } else {
    html = `<a href="${src}">${label}</a>`;
  }
  return {
    altSource,
    snippets: {
      markdown: `${kind === "image" ? "!" : ""}[${markdownLabel}](${url})`,
      html,
      curl: `curl -O ${url}`,
    },
  };
}

async function loadActiveDrafts(db: AppDeps["db"]): Promise<DraftRecord[]> {
  const items: DraftRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listDrafts({
      db,
      status: "active",
      limit: LIST_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }
  return items;
}

async function renderKeys(
  reply: FastifyReply,
  deps: AppDeps,
  extra: { secret: string | null; error: string | null; csrf: string | null },
): Promise<unknown> {
  const tokens = await listTokens(deps.db);
  const rows: TokenRow[] = tokens.map((token) => ({
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdLabel: formatStamp(token.createdAt),
    createdIso: isoStamp(token.createdAt),
    lastUsedLabel: formatStamp(token.lastUsedAt),
    lastUsedIso: isoStamp(token.lastUsedAt),
  }));
  return reply.view("tokens/list", {
    title: "API keys",
    active: "keys",
    csrf: extra.csrf,
    tokens: rows,
    secret: extra.secret,
    error: extra.error,
  });
}

export async function registerDashboardRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const dashboardOnly = { constraints: { host: dashboardHostConstraint(deps.config.baseDomain) } };

  app.get<{ Querystring: { show?: unknown } }>("/", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const show = parseShow(request.query.show);
    const drafts = await loadActiveDrafts(deps.db);
    const list = buildDraftList(drafts, deps.urls, show);
    return reply.view("drafts/list", {
      title: "Drafts",
      active: "drafts",
      csrf: request.adminCsrf,
      show,
      rows: list.rows,
      totalCount: list.totalCount,
      favoriteCount: list.favoriteCount,
    });
  });

  app.get<{ Params: IdParams }>("/drafts/:id", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const draft = await getDraft(deps.db, request.params.id);
    if (isServiceError(draft)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    const versions = await listVersions(deps.db, draft.id);
    if (isServiceError(versions)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    return reply.view("drafts/detail", {
      title: draftTitle(draft.title),
      active: "drafts",
      csrf: request.adminCsrf,
      draft: {
        id: draft.id,
        title: draftTitle(draft.title),
        titleValue: draft.title ?? "",
        description: draft.description?.trim() ?? "",
        publicUrl: deps.urls.publicUrl(draft.slug),
      },
      versions: versions.map((version) =>
        toVersionRow(version, deps.urls.publicUrl(draft.slug, version.versionNumber)),
      ),
    });
  });

  app.post<{ Params: IdParams }>("/drafts/:id", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const updated = await patchDraft({
      db: deps.db,
      id: request.params.id,
      title: readField(request.body, "title"),
      description: readField(request.body, "description"),
    });
    if (isServiceError(updated)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    return reply.redirect(`/drafts/${updated.id}`);
  });

  app.post<{ Params: IdParams }>("/drafts/:id/favorite", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const updated = await setDraftFavorite({
      db: deps.db,
      id: request.params.id,
      favorite: readField(request.body, "favorite") === "1",
    });
    if (isServiceError(updated)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    // Back to the view the star was clicked in; only these two fixed paths, never a caller URL.
    return reply.redirect(readField(request.body, "show") === "favorites" ? "/?show=favorites" : "/");
  });

  app.post<{ Params: IdParams }>("/drafts/:id/delete", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const deleted = await deleteDraft(deps.db, request.params.id);
    if (isServiceError(deleted)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    return reply.redirect("/");
  });

  app.get("/keys", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    return renderKeys(reply, deps, { secret: null, error: null, csrf: request.adminCsrf });
  });

  app.post("/keys", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const name = readField(request.body, "name") ?? `API · ${formatStamp(new Date())}`;
    const created = await createToken({
      db: deps.db,
      pepper: deps.config.tokenPepper,
      name,
    });
    return renderKeys(reply, deps, { secret: created.secret, error: null, csrf: request.adminCsrf });
  });

  app.post<{ Params: IdParams }>("/keys/:id/revoke", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const revoked = await revokeToken(deps.db, request.params.id);
    if (isServiceError(revoked)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    return reply.redirect("/keys");
  });

  app.get<{ Querystring: { deleted?: unknown } }>("/assets", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const items: AssetItemRow[] = [];
    let totalBytes = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await listAssets({
        db: deps.db,
        limit: DASH_ASSET_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (isServiceError(page)) {
        return reply.code(400).type("text/plain").send(page.detail);
      }
      for (const asset of page.items) {
        if (items.length >= DASH_ASSET_CAP) {
          break;
        }
        const filename = assetDisplayName(asset.filename);
        totalBytes += asset.byteSize;
        items.push({
          id: asset.id,
          filename,
          description: asset.description,
          detailUrl: `/assets/${asset.id}`,
          thumbUrl: deps.assetUrls.publicUrl(asset.id, asset.filename),
          sizeLabel: formatBytes(asset.byteSize),
          kind: assetKindFromContentType(asset.contentType),
          extLabel: assetExtLabel(filename),
          uploadedLabel: formatStamp(asset.createdAt),
          uploadedIso: isoStamp(asset.createdAt),
        });
      }
      if (items.length >= DASH_ASSET_CAP) {
        break;
      }
      if (page.nextCursor == null) {
        break;
      }
      cursor = page.nextCursor;
    }
    return reply.view("assets/list", {
      title: "Assets",
      active: "assets",
      csrf: request.adminCsrf,
      items,
      summary: `${fileCountLabel(items.length)} · ${formatBytes(totalBytes)}`,
      // Set by the delete redirect so the list can confirm what just happened.
      deleted: request.query.deleted === "1",
    });
  });

  app.post(
    "/assets",
    { ...dashboardOnly, bodyLimit: MAX_ASSET_BYTES + 1024 * 1024 },
    async (request, reply) => {
      if (!isDashboardHost(request)) {
        return;
      }
      let uploads: { bytes: Buffer; filename: string; contentType: string }[];
      let suppliedCsrf: string | null = null;
      try {
        uploads = [];
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type !== "file") {
            if (part.fieldname === "_csrf" && typeof part.value === "string") {
              suppliedCsrf = part.value;
            }
            continue;
          }
          if (part.fieldname !== "file") {
            await part.toBuffer();
            continue;
          }
          const bytes = await part.toBuffer();
          if (bytes.byteLength > MAX_ASSET_BYTES) {
            return reply.code(413).type("text/plain").send("file exceeds 100 MiB");
          }
          uploads.push({
            bytes,
            filename: part.filename,
            contentType: part.mimetype || "application/octet-stream",
          });
        }
      } catch {
        return reply.code(413).type("text/plain").send("file exceeds 100 MiB");
      }
      if (
        request.adminCsrf === null ||
        suppliedCsrf === null ||
        !hashesEqual(suppliedCsrf, request.adminCsrf)
      ) {
        return reply.code(403).type("text/plain").send("bad csrf");
      }
      if (uploads.length === 0) {
        return reply.code(400).type("text/plain").send("file is required");
      }
      for (const upload of uploads) {
        const created = await createAsset({
          db: deps.db,
          s3: deps.s3,
          bucket: deps.config.s3Bucket,
          urls: deps.assetUrls,
          bytes: upload.bytes,
          filename: upload.filename,
          contentType: contentTypeForUpload(upload.contentType || undefined, upload.filename),
        });
        if (isServiceError(created)) {
          return reply.code(400).type("text/plain").send(created.detail);
        }
      }
      return reply.redirect("/assets");
    },
  );

  app.get<{ Params: IdParams }>("/assets/:id", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const asset = await getAsset(deps.db, request.params.id);
    if (isServiceError(asset)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    const filename = assetDisplayName(asset.filename);
    const description = asset.description?.trim() || "";
    const previewUrl = deps.assetUrls.publicUrl(asset.id, asset.filename);
    const references = assetReferenceData(asset, previewUrl);
    const neighbors = await getAssetNeighbors(deps.db, asset);
    const pagerLink = (neighbor: (typeof neighbors)["previous"]) =>
      neighbor ? { href: `/assets/${neighbor.id}`, name: assetDisplayName(neighbor.filename) } : null;
    return reply.view("assets/detail", {
      title: filename,
      active: "assets",
      csrf: request.adminCsrf,
      pager: {
        position: neighbors.position,
        total: neighbors.total,
        previous: pagerLink(neighbors.previous),
        next: pagerLink(neighbors.next),
      },
      asset: {
        id: asset.id,
        filename,
        description,
        descriptionValue: description,
        altSource: references.altSource,
        previewUrl,
        kind: assetKindFromContentType(asset.contentType),
        contentType: asset.contentType,
        sizeLabel: formatBytes(asset.byteSize),
        uploadedLabel: formatStamp(asset.createdAt),
        uploadedIso: isoStamp(asset.createdAt),
      },
      snippets: references.snippets,
    });
  });

  app.post<{ Params: IdParams }>("/assets/:id", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const description = normalizeAssetDescription(readField(request.body, "description"));
    if (isServiceError(description)) {
      return reply.code(400).type("text/plain").send(description.detail);
    }
    const updated = await patchAsset({
      db: deps.db,
      id: request.params.id,
      description: description ?? null,
    });
    if (isServiceError(updated)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    if (request.headers.accept === "application/json") {
      const url = deps.assetUrls.publicUrl(updated.id, updated.filename);
      return reply.send({ description: updated.description ?? "", ...assetReferenceData(updated, url) });
    }
    return reply.redirect(`/assets/${updated.id}`);
  });

  app.post<{ Params: IdParams }>("/assets/:id/delete", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const deleted = await deleteAsset({
      db: deps.db,
      s3: deps.s3,
      bucket: deps.config.s3Bucket,
      id: request.params.id,
    });
    if (isServiceError(deleted)) {
      return reply.code(404).type("text/plain").send("not found");
    }
    return reply.redirect("/assets?deleted=1");
  });
}
