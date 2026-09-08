import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { dashboardHostConstraint, isDashboardHostKind } from "../lib/host.js";
import { formatStamp, shortCommit } from "../lib/time.js";
import { hashesEqual } from "../lib/tokens.js";
import {
  deleteDraft,
  getDraft,
  listDrafts,
  listVersions,
  patchDraft,
  type DraftUrls,
} from "../services/drafts.js";
import {
  contentTypeForUpload,
  createAsset,
  deleteAsset,
  formatBytes,
  getAsset,
  listAssets,
  MAX_ASSET_BYTES,
} from "../services/assets.js";
import { createToken, listTokens, revokeToken } from "../services/tokens.js";
import type { DraftRecord, VersionRecord } from "../services/types.js";
import { isServiceError } from "../services/types.js";

type IdParams = {
  id: string;
};

type DraftListRow = {
  id: string;
  title: string;
  publicUrl: string;
  description: string;
  versionLabel: string;
  versionsLabel: string;
  updatedLabel: string;
};

type DraftListGroup = {
  heading: string;
  repositoryUrl: string | null;
  drafts: DraftListRow[];
};

type VersionRow = {
  versionLabel: string;
  versionUrl: string;
  commitLabel: string;
  dirty: boolean;
  refLabel: string;
  publishedLabel: string;
};

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  createdLabel: string;
  lastUsedLabel: string;
};

type AssetItemRow = {
  id: string;
  filename: string;
  detailUrl: string;
  thumbUrl: string;
  sizeLabel: string;
  kind: "image" | "video" | "audio" | "pdf" | "other";
  extLabel: string;
};

const LIST_PAGE = 100;
const DASH_ASSET_PAGE = 100;
const DASH_ASSET_CAP = 2000;

function isDashboardHost(request: FastifyRequest): boolean {
  return isDashboardHostKind(request.hostKind.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(body: unknown, key: string): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const value = body[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function draftTitle(title: string | null): string {
  const trimmed = title?.trim() ?? "";
  return trimmed === "" ? "Untitled draft" : trimmed;
}

function versionCountLabel(count: number): string {
  return count === 1 ? "1 version" : `${String(count)} versions`;
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

function toListRow(draft: DraftRecord, urls: DraftUrls): DraftListRow {
  return {
    id: draft.id,
    title: draftTitle(draft.title),
    publicUrl: urls.publicUrl(draft.slug),
    description: draft.description?.trim() ?? "",
    versionLabel: `v${String(draft.currentVersion)}`,
    versionsLabel: versionCountLabel(draft.currentVersion),
    updatedLabel: formatStamp(draft.updatedAt),
  };
}

function groupDrafts(drafts: DraftRecord[], urls: DraftUrls): DraftListGroup[] {
  const buckets = new Map<string, DraftRecord[]>();
  for (const draft of drafts) {
    const key = draft.repositoryName?.trim() ?? "";
    const existing = buckets.get(key);
    if (existing) {
      existing.push(draft);
    } else {
      buckets.set(key, [draft]);
    }
  }

  const named = [...buckets.keys()].filter((key) => key !== "").sort((a, b) => a.localeCompare(b));
  const keys = buckets.has("") ? [...named, ""] : named;

  return keys.map((key) => {
    const items = buckets.get(key) ?? [];
    items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    let repositoryUrl: string | null = null;
    for (const draft of items) {
      const url = draft.repositoryUrl?.trim() ?? "";
      if (url !== "") {
        repositoryUrl = url;
        break;
      }
    }
    return {
      heading: key === "" ? "No repository" : key,
      repositoryUrl,
      drafts: items.map((draft) => toListRow(draft, urls)),
    };
  });
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
    lastUsedLabel: formatStamp(token.lastUsedAt),
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

  app.get("/", dashboardOnly, async (request, reply) => {
    if (!isDashboardHost(request)) {
      return;
    }
    const drafts = await loadActiveDrafts(deps.db);
    return reply.view("drafts/list", {
      title: "My drafts",
      active: "drafts",
      csrf: request.adminCsrf,
      groups: groupDrafts(drafts, deps.urls),
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

  app.get("/assets", dashboardOnly, async (request, reply) => {
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
          detailUrl: `/assets/${asset.id}`,
          thumbUrl: deps.assetUrls.publicUrl(asset.id, asset.filename),
          sizeLabel: formatBytes(asset.byteSize),
          kind: assetKindFromContentType(asset.contentType),
          extLabel: assetExtLabel(filename),
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
      summary: `${String(items.length)} file(s) · ${formatBytes(totalBytes)}`,
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
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const previewUrl = deps.assetUrls.publicUrl(asset.id, asset.filename);
    return reply.view("assets/detail", {
      title: filename,
      active: "assets",
      csrf: request.adminCsrf,
      asset: {
        id: asset.id,
        filename,
        previewUrl,
        kind: assetKindFromContentType(asset.contentType),
        contentType: asset.contentType,
        sizeLabel: formatBytes(asset.byteSize),
        sha256: asset.sha256,
        shaShort: asset.sha256.length > 20 ? `${asset.sha256.slice(0, 20)}…` : asset.sha256,
        uploadedLabel: formatStamp(asset.createdAt),
      },
      snippets: {
        direct: previewUrl,
        markdown: `![${base}](${previewUrl})`,
        html: `<img src="${previewUrl}" alt="${base}">`,
        curl: `curl -O ${previewUrl}`,
      },
    });
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
    return reply.redirect("/assets");
  });
}
