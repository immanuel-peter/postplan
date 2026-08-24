import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { formatStamp, shortCommit } from "../lib/time.js";
import {
  deleteDraft,
  getDraft,
  listDrafts,
  listVersions,
  patchDraft,
  type DraftUrls,
} from "../services/drafts.js";
import { createToken, listTokens, revokeToken } from "../services/tokens.js";
import type { DraftRecord, VersionRecord } from "../services/types.js";
import { isServiceError } from "../services/types.js";

type IdParams = {
  id: string;
};

type DraftListRow = {
  id: string;
  title: string;
  versionUrl: string;
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

const LIST_PAGE = 100;

function dashboardHostConstraint(baseDomain: string): RegExp {
  const escaped = baseDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${escaped}|localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?$`, "i");
}

function isDashboardHost(request: FastifyRequest): boolean {
  const kind = request.hostKind.kind;
  switch (kind) {
    case "apex":
    case "local":
      return true;
    case "draft":
    case "reject":
      return false;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
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
    versionUrl: urls.publicUrl(draft.slug, draft.currentVersion),
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
  extra: { secret: string | null; error: string | null },
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
    return renderKeys(reply, deps, { secret: null, error: null });
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
    return renderKeys(reply, deps, { secret: created.secret, error: null });
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
}
