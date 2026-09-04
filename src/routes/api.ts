import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { requireToken } from "../lib/auth.js";
import { currentEtag } from "../lib/csp.js";
import { sha256Hex } from "../lib/hash.js";
import { optionalField, parseExpectedVersion, readAssetUpload, readMultipart } from "../lib/multipart.js";
import { problem, sendProblem } from "../lib/problems.js";
import {
  contentTypeForUpload,
  createAsset,
  deleteAsset,
  getAsset,
  listAssets,
  toAssetResponse,
} from "../services/assets.js";
import {
  addVersion,
  createDraft,
  deleteDraft,
  getDraft,
  getIdempotentResult,
  getVersion,
  latestVersion,
  listDrafts,
  listVersions,
  patchDraft,
  requestHash,
  storeIdempotentResult,
  toDraftResponse,
} from "../services/drafts.js";
import { createToken, listTokens, revokeToken } from "../services/tokens.js";
import type { DraftResponse, DraftStatus, ServiceError, TokenRecord, VersionRecord } from "../services/types.js";
import { isServiceError } from "../services/types.js";

const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    currentVersion: { type: "integer" },
  },
};

const draftResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "slug",
    "title",
    "description",
    "status",
    "currentVersion",
    "publicUrl",
    "versionUrl",
    "contentSha256",
    "byteSize",
    "repositoryUrl",
    "repositoryName",
    "gitRef",
    "gitCommit",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    title: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    status: { type: "string", enum: ["active", "deleted"] },
    currentVersion: { type: "integer" },
    publicUrl: { type: "string" },
    versionUrl: { type: "string" },
    contentSha256: { type: "string" },
    byteSize: { type: "integer" },
    repositoryUrl: { type: ["string", "null"] },
    repositoryName: { type: ["string", "null"] },
    gitRef: { type: ["string", "null"] },
    gitCommit: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
};

const versionMetadataSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "versionNumber",
    "contentSha256",
    "byteSize",
    "gitRef",
    "gitCommit",
    "sourceFilename",
    "securityPolicyVersion",
    "createdAt",
  ],
  properties: {
    versionNumber: { type: "integer" },
    contentSha256: { type: "string" },
    byteSize: { type: "integer" },
    gitRef: { type: ["string", "null"] },
    gitCommit: { type: ["string", "null"] },
    sourceFilename: { type: ["string", "null"] },
    securityPolicyVersion: { type: "integer" },
    createdAt: { type: "string" },
  },
};

const tokenItemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "prefix", "scopes", "expiresAt", "lastUsedAt", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    expiresAt: { type: ["string", "null"] },
    lastUsedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
};

const createdTokenSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "prefix", "scopes", "expiresAt", "lastUsedAt", "revokedAt", "createdAt", "token"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    expiresAt: { type: ["string", "null"] },
    lastUsedAt: { type: ["string", "null"] },
    revokedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
    token: { type: "string" },
  },
};

const assetResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "url", "contentType", "byteSize", "sha256", "filename", "createdAt"],
  properties: {
    id: { type: "string" },
    url: { type: "string" },
    contentType: { type: "string" },
    byteSize: { type: "integer" },
    sha256: { type: "string" },
    filename: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
};

const security = [{ bearerAuth: [] }];

const errorResponses = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
};

type PatchDraftFields = {
  title?: string | null;
  description?: string | null;
  repositoryUrl?: string | null;
  repositoryName?: string | null;
  gitRef?: string | null;
  gitCommit?: string | null;
};

const PATCH_DRAFT_KEYS: (keyof PatchDraftFields)[] = [
  "title",
  "description",
  "repositoryUrl",
  "repositoryName",
  "gitRef",
  "gitCommit",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") {
      const trimmed = first.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}

function queryField(query: unknown, key: string): string | undefined {
  if (!isPlainObject(query)) {
    return undefined;
  }
  const value = query[key];
  return typeof value === "string" ? value : undefined;
}

function parseListStatus(raw: string | undefined): { ok: true; status?: DraftStatus } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true };
  }
  if (raw === "active" || raw === "deleted") {
    return { ok: true, status: raw };
  }
  return { ok: false };
}

function parseListLimit(raw: string | undefined): { ok: true; limit: number } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true, limit: 50 };
  }
  if (!/^\d+$/.test(raw)) {
    return { ok: false };
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false };
  }
  return { ok: true, limit: Math.min(n, 100) };
}

function parseVersionNumber(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  return Number.parseInt(raw, 10);
}

function parsePatchDraftBody(body: unknown): { ok: true; fields: PatchDraftFields } | { ok: false; detail: string } {
  if (!isPlainObject(body)) {
    return { ok: false, detail: "JSON object required" };
  }
  const fields: PatchDraftFields = {};
  for (const key of PATCH_DRAFT_KEYS) {
    if (!(key in body)) {
      continue;
    }
    const value = body[key];
    if (value !== null && typeof value !== "string") {
      return { ok: false, detail: `${key} must be a string or null` };
    }
    fields[key] = value;
  }
  return { ok: true, fields };
}

function parseCreateTokenBody(
  body: unknown,
): { ok: true; name: string; expiresAt?: Date | null } | { ok: false; detail: string } {
  if (!isPlainObject(body)) {
    return { ok: false, detail: "JSON object required" };
  }
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, detail: "name is required" };
  }
  if (body.expiresAt === undefined) {
    return { ok: true, name: name.trim() };
  }
  if (body.expiresAt === null) {
    return { ok: true, name: name.trim(), expiresAt: null };
  }
  if (typeof body.expiresAt !== "string") {
    return { ok: false, detail: "expiresAt must be an ISO-8601 string" };
  }
  const expiresAt = new Date(body.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, detail: "expiresAt must be an ISO-8601 string" };
  }
  return { ok: true, name: name.trim(), expiresAt };
}

function toVersionMetadata(version: VersionRecord) {
  return {
    versionNumber: version.versionNumber,
    contentSha256: version.contentSha256,
    byteSize: version.byteSize,
    gitRef: version.gitRef,
    gitCommit: version.gitCommit,
    sourceFilename: version.sourceFilename,
    securityPolicyVersion: version.securityPolicyVersion,
    createdAt: version.createdAt.toISOString(),
  };
}

function toTokenItem(token: TokenRecord) {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt ? token.expiresAt.toISOString() : null,
    lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
    createdAt: token.createdAt.toISOString(),
  };
}

function sendDraftCreated(reply: FastifyReply, draft: DraftResponse): FastifyReply {
  return reply.code(201).header("ETag", currentEtag(draft.id, draft.currentVersion)).send(draft);
}

function sendServiceError(reply: FastifyReply, error: ServiceError): FastifyReply {
  const { kind } = error;
  switch (kind) {
    case "not_found":
      return sendProblem(reply, problem(404, error.title, error.detail));
    case "validation":
      return sendProblem(reply, problem(400, error.title, error.detail));
    case "precondition":
      return sendProblem(
        reply,
        problem(
          409,
          error.title,
          error.detail,
          error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion },
        ),
      );
    case "conflict":
      return sendProblem(reply, problem(409, error.title, error.detail));
    case "gone":
      return sendProblem(reply, problem(410, error.title, error.detail));
    default: {
      const _exhaustive: never = kind;
      return sendProblem(reply, problem(500, "Internal Server Error", String(_exhaustive)));
    }
  }
}

async function ensureJsonBody(request: FastifyRequest): Promise<void> {
  if (request.body === undefined) {
    request.body = {};
  }
}

export async function registerApiRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(async (api) => {
    api.addHook("onRequest", async (request, reply) => {
      if (request.hostKind.kind === "draft" || request.hostKind.kind === "assets") {
        return reply.code(404).type("text/plain").send("not found");
      }
    });

    api.setErrorHandler((error: FastifyError, _request, reply) => {
      if (error.validation) {
        return sendProblem(reply, problem(400, "Bad Request", error.message));
      }
      if (error.statusCode === 413) {
        return sendProblem(reply, problem(413, "Payload Too Large", error.message));
      }
      return reply.send(error);
    });

    api.post(
      "/drafts",
      {
        preValidation: ensureJsonBody,
        schema: {
          tags: ["drafts"],
          summary: "Create a Draft and publish Version 1",
          security,
          consumes: ["multipart/form-data"],
          headers: {
            type: "object",
            properties: {
              authorization: { type: "string" },
              "idempotency-key": { type: "string" },
            },
          },
          body: {
            type: "object",
            properties: {
              html: { type: "string", format: "binary" },
              title: { type: "string" },
              description: { type: "string" },
              repository_url: { type: "string" },
              repository_name: { type: "string" },
              git_ref: { type: "string" },
              git_commit: { type: "string" },
            },
          },
          response: {
            201: draftResponseSchema,
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:write");
        if (!token) {
          return;
        }

        const multipart = await readMultipart(request);
        if (!multipart.html) {
          return sendProblem(reply, problem(400, "Bad Request", "html file is required"));
        }

        const title = optionalField(multipart.fields, "title") ?? null;
        const description = optionalField(multipart.fields, "description") ?? null;
        const repositoryUrl = optionalField(multipart.fields, "repository_url") ?? null;
        const repositoryName = optionalField(multipart.fields, "repository_name") ?? null;
        const gitRef = optionalField(multipart.fields, "git_ref") ?? null;
        const gitCommit = optionalField(multipart.fields, "git_commit") ?? null;
        const hash = requestHash([
          "POST",
          "/api/v1/drafts",
          sha256Hex(multipart.html),
          JSON.stringify({
            title,
            description,
            repository_url: repositoryUrl,
            repository_name: repositoryName,
            git_ref: gitRef,
            git_commit: gitCommit,
          }),
        ]);

        const idempotencyKey = headerValue(request, "idempotency-key");
        if (idempotencyKey) {
          const existing = await getIdempotentResult({
            db: deps.db,
            key: idempotencyKey,
            requestHash: hash,
          });
          if ("hit" in existing) {
            return sendDraftCreated(reply, existing.hit);
          }
          if ("replayConflict" in existing) {
            return sendProblem(
              reply,
              problem(409, "Conflict", "Idempotency-Key reused with a different request"),
            );
          }
        }

        const created = await createDraft({
          db: deps.db,
          s3: deps.s3,
          bucket: deps.config.s3Bucket,
          urls: deps.urls,
          html: multipart.html,
          title,
          description,
          repositoryUrl,
          repositoryName,
          gitRef,
          gitCommit,
          sourceFilename: multipart.filename,
        });
        if (isServiceError(created)) {
          return sendServiceError(reply, created);
        }

        const body = toDraftResponse({
          draft: created.draft,
          version: created.version,
          urls: deps.urls,
        });
        if (idempotencyKey) {
          await storeIdempotentResult({
            db: deps.db,
            key: idempotencyKey,
            requestHash: hash,
            result: body,
          });
        }
        return sendDraftCreated(reply, body);
      },
    );

    api.get(
      "/drafts",
      {
        schema: {
          tags: ["drafts"],
          summary: "List Drafts",
          security,
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["active", "deleted"] },
              repository: { type: "string" },
              cursor: { type: "string" },
              limit: { type: "string" },
            },
          },
          response: {
            200: {
              type: "object",
              required: ["items", "nextCursor"],
              properties: {
                items: { type: "array", items: draftResponseSchema },
                nextCursor: { type: ["string", "null"] },
              },
            },
            400: problemSchema,
            401: problemSchema,
            403: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }

        const statusParsed = parseListStatus(queryField(request.query, "status"));
        if (!statusParsed.ok) {
          return sendProblem(reply, problem(400, "Bad Request", "status must be active or deleted"));
        }
        const limitParsed = parseListLimit(queryField(request.query, "limit"));
        if (!limitParsed.ok) {
          return sendProblem(reply, problem(400, "Bad Request", "limit must be an integer from 1 to 100"));
        }

        const repository = queryField(request.query, "repository");
        const cursor = queryField(request.query, "cursor");
        const listed = await listDrafts({
          db: deps.db,
          limit: limitParsed.limit,
          ...(statusParsed.status !== undefined ? { status: statusParsed.status } : {}),
          ...(repository !== undefined ? { repository } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });

        const items: DraftResponse[] = [];
        for (const draft of listed.items) {
          const version = await latestVersion(deps.db, draft.id);
          if (!version) {
            continue;
          }
          items.push(toDraftResponse({ draft, version, urls: deps.urls }));
        }
        return { items, nextCursor: listed.nextCursor };
      },
    );

    api.get<{ Params: { id: string } }>(
      "/drafts/:id",
      {
        schema: {
          tags: ["drafts"],
          summary: "Get a Draft",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            200: draftResponseSchema,
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }

        const draft = await getDraft(deps.db, request.params.id);
        if (isServiceError(draft)) {
          return sendServiceError(reply, draft);
        }
        const version = await latestVersion(deps.db, draft.id);
        if (!version) {
          return sendProblem(reply, problem(404, "Not found", "draft not found"));
        }
        return toDraftResponse({ draft, version, urls: deps.urls });
      },
    );

    api.patch<{ Params: { id: string } }>(
      "/drafts/:id",
      {
        schema: {
          tags: ["drafts"],
          summary: "Update Draft metadata",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: ["string", "null"] },
              description: { type: ["string", "null"] },
              repositoryUrl: { type: ["string", "null"] },
              repositoryName: { type: ["string", "null"] },
              gitRef: { type: ["string", "null"] },
              gitCommit: { type: ["string", "null"] },
            },
          },
          response: {
            200: draftResponseSchema,
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:write");
        if (!token) {
          return;
        }

        const parsed = parsePatchDraftBody(request.body === undefined ? {} : request.body);
        if (!parsed.ok) {
          return sendProblem(reply, problem(400, "Bad Request", parsed.detail));
        }

        const draft = await patchDraft({
          db: deps.db,
          id: request.params.id,
          ...parsed.fields,
        });
        if (isServiceError(draft)) {
          return sendServiceError(reply, draft);
        }
        const version = await latestVersion(deps.db, draft.id);
        if (!version) {
          return sendProblem(reply, problem(404, "Not found", "draft not found"));
        }
        return toDraftResponse({ draft, version, urls: deps.urls });
      },
    );

    api.delete<{ Params: { id: string } }>(
      "/drafts/:id",
      {
        schema: {
          tags: ["drafts"],
          summary: "Soft-delete a Draft",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            204: { type: "null", description: "No Content" },
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:delete");
        if (!token) {
          return;
        }

        const deleted = await deleteDraft(deps.db, request.params.id);
        if (isServiceError(deleted)) {
          return sendServiceError(reply, deleted);
        }
        return reply.code(204).send();
      },
    );

    api.post<{ Params: { id: string } }>(
      "/drafts/:id/versions",
      {
        preValidation: ensureJsonBody,
        schema: {
          tags: ["drafts"],
          summary: "Append a Version",
          security,
          consumes: ["multipart/form-data"],
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          headers: {
            type: "object",
            properties: {
              authorization: { type: "string" },
              "if-match": { type: "string" },
              "idempotency-key": { type: "string" },
            },
          },
          body: {
            type: "object",
            properties: {
              html: { type: "string", format: "binary" },
              git_ref: { type: "string" },
              git_commit: { type: "string" },
              expectedVersion: { type: "string" },
            },
          },
          response: {
            201: draftResponseSchema,
            ...errorResponses,
            428: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:write");
        if (!token) {
          return;
        }

        const multipart = await readMultipart(request);
        if (!multipart.html) {
          return sendProblem(reply, problem(400, "Bad Request", "html file is required"));
        }

        const ifMatch = headerValue(request, "if-match");
        const expectedField = multipart.fields.expectedVersion;
        if (!ifMatch && (expectedField === undefined || expectedField.trim() === "")) {
          return sendProblem(
            reply,
            problem(428, "Precondition required", "If-Match or expectedVersion is required"),
          );
        }

        const expectedVersion = parseExpectedVersion({
          ...(ifMatch === undefined ? {} : { header: ifMatch }),
          ...(expectedField === undefined ? {} : { field: expectedField }),
        });
        if (expectedVersion === null) {
          return sendProblem(reply, problem(400, "Bad Request", "invalid expected version"));
        }

        const gitRef = optionalField(multipart.fields, "git_ref");
        const gitCommit = optionalField(multipart.fields, "git_commit");
        const hash = requestHash([
          "POST",
          `/api/v1/drafts/${request.params.id}/versions`,
          request.params.id,
          String(expectedVersion),
          sha256Hex(multipart.html),
        ]);

        const idempotencyKey = headerValue(request, "idempotency-key");
        if (idempotencyKey) {
          const existing = await getIdempotentResult({
            db: deps.db,
            key: idempotencyKey,
            requestHash: hash,
          });
          if ("hit" in existing) {
            return sendDraftCreated(reply, existing.hit);
          }
          if ("replayConflict" in existing) {
            return sendProblem(
              reply,
              problem(409, "Conflict", "Idempotency-Key reused with a different request"),
            );
          }
        }

        const created = await addVersion({
          db: deps.db,
          s3: deps.s3,
          bucket: deps.config.s3Bucket,
          draftId: request.params.id,
          expectedVersion,
          html: multipart.html,
          sourceFilename: multipart.filename,
          ...(gitRef !== undefined ? { gitRef } : {}),
          ...(gitCommit !== undefined ? { gitCommit } : {}),
        });
        if (isServiceError(created)) {
          return sendServiceError(reply, created);
        }

        const body = toDraftResponse({
          draft: created.draft,
          version: created.version,
          urls: deps.urls,
        });
        if (idempotencyKey) {
          await storeIdempotentResult({
            db: deps.db,
            key: idempotencyKey,
            requestHash: hash,
            result: body,
          });
        }
        return sendDraftCreated(reply, body);
      },
    );

    api.get<{ Params: { id: string } }>(
      "/drafts/:id/versions",
      {
        schema: {
          tags: ["drafts"],
          summary: "List Versions of a Draft",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            200: { type: "array", items: versionMetadataSchema },
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }

        const versions = await listVersions(deps.db, request.params.id);
        if (isServiceError(versions)) {
          return sendServiceError(reply, versions);
        }
        return versions.map(toVersionMetadata);
      },
    );

    api.get<{ Params: { id: string; number: string } }>(
      "/drafts/:id/versions/:number",
      {
        schema: {
          tags: ["drafts"],
          summary: "Get Version metadata",
          security,
          params: {
            type: "object",
            required: ["id", "number"],
            properties: {
              id: { type: "string" },
              number: { type: "string", pattern: "^[1-9]\\d*$" },
            },
          },
          response: {
            200: versionMetadataSchema,
            400: problemSchema,
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }

        const versionNumber = parseVersionNumber(request.params.number);
        if (versionNumber === null) {
          return sendProblem(reply, problem(400, "Bad Request", "invalid version number"));
        }

        const version = await getVersion(deps.db, request.params.id, versionNumber);
        if (isServiceError(version)) {
          return sendServiceError(reply, version);
        }
        return toVersionMetadata(version);
      },
    );

    api.post(
      "/assets",
      {
        preValidation: ensureJsonBody,
        schema: {
          tags: ["assets"],
          summary: "Upload an Asset",
          security,
          consumes: ["multipart/form-data"],
          body: {
            type: "object",
            properties: {
              file: { type: "string", format: "binary" },
            },
          },
          response: {
            201: assetResponseSchema,
            ...errorResponses,
            413: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:write");
        if (!token) {
          return;
        }

        let upload;
        try {
          upload = await readAssetUpload(request);
        } catch (error: unknown) {
          if (
            typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            (error as { statusCode?: unknown }).statusCode === 413
          ) {
            return sendProblem(
              reply,
              problem(413, "Payload Too Large", error instanceof Error ? error.message : "file too large"),
            );
          }
          throw error;
        }
        const file = upload.files[0];
        if (!file) {
          return sendProblem(reply, problem(400, "Bad Request", "file is required"));
        }

        const created = await createAsset({
          db: deps.db,
          s3: deps.s3,
          bucket: deps.config.s3Bucket,
          urls: deps.assetUrls,
          bytes: file.bytes,
          filename: file.filename,
          contentType: contentTypeForUpload(file.mimetype || undefined, file.filename),
        });
        if (isServiceError(created)) {
          return sendServiceError(reply, created);
        }
        return reply.code(201).send(toAssetResponse(created, deps.assetUrls));
      },
    );

    api.get(
      "/assets",
      {
        schema: {
          tags: ["assets"],
          summary: "List Assets",
          security,
          querystring: {
            type: "object",
            properties: {
              cursor: { type: "string" },
              limit: { type: "string" },
            },
          },
          response: {
            200: {
              type: "object",
              required: ["items", "nextCursor"],
              properties: {
                items: { type: "array", items: assetResponseSchema },
                nextCursor: { type: ["string", "null"] },
              },
            },
            400: problemSchema,
            401: problemSchema,
            403: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }

        const limitParsed = parseListLimit(queryField(request.query, "limit"));
        if (!limitParsed.ok) {
          return sendProblem(reply, problem(400, "Bad Request", "limit must be an integer from 1 to 100"));
        }

        const cursor = queryField(request.query, "cursor");
        const listed = await listAssets({
          db: deps.db,
          limit: limitParsed.limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return {
          items: listed.items.map((item) => toAssetResponse(item, deps.assetUrls)),
          nextCursor: listed.nextCursor,
        };
      },
    );

    api.get<{ Params: { id: string } }>(
      "/assets/:id",
      {
        schema: {
          tags: ["assets"],
          summary: "Get an Asset",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            200: assetResponseSchema,
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }

        const record = await getAsset(deps.db, request.params.id);
        if (isServiceError(record)) {
          return sendServiceError(reply, record);
        }
        return toAssetResponse(record, deps.assetUrls);
      },
    );

    api.delete<{ Params: { id: string } }>(
      "/assets/:id",
      {
        schema: {
          tags: ["assets"],
          summary: "Delete an Asset",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            204: { type: "null", description: "No Content" },
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:delete");
        if (!token) {
          return;
        }

        const deleted = await deleteAsset({
          db: deps.db,
          s3: deps.s3,
          bucket: deps.config.s3Bucket,
          id: request.params.id,
        });
        if (isServiceError(deleted)) {
          return sendServiceError(reply, deleted);
        }
        return reply.code(204).send();
      },
    );

    api.get(
      "/tokens",
      {
        schema: {
          tags: ["tokens"],
          summary: "List Tokens",
          security,
          response: {
            200: {
              type: "object",
              required: ["items"],
              properties: {
                items: { type: "array", items: tokenItemSchema },
              },
            },
            401: problemSchema,
            403: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "tokens:manage");
        if (!token) {
          return;
        }
        const items = await listTokens(deps.db);
        return { items: items.map(toTokenItem) };
      },
    );

    api.post(
      "/tokens",
      {
        schema: {
          tags: ["tokens"],
          summary: "Create a Token",
          security,
          body: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: {
              name: { type: "string", minLength: 1 },
              expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
            },
          },
          response: {
            201: createdTokenSchema,
            400: problemSchema,
            401: problemSchema,
            403: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "tokens:manage");
        if (!token) {
          return;
        }

        const parsed = parseCreateTokenBody(request.body);
        if (!parsed.ok) {
          return sendProblem(reply, problem(400, "Bad Request", parsed.detail));
        }

        const created = await createToken({
          db: deps.db,
          pepper: deps.config.tokenPepper,
          name: parsed.name,
          ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
        });

        return reply.code(201).send({
          id: created.record.id,
          name: created.record.name,
          prefix: created.record.prefix,
          scopes: created.record.scopes,
          expiresAt: created.record.expiresAt ? created.record.expiresAt.toISOString() : null,
          lastUsedAt: created.record.lastUsedAt ? created.record.lastUsedAt.toISOString() : null,
          revokedAt: created.record.revokedAt ? created.record.revokedAt.toISOString() : null,
          createdAt: created.record.createdAt.toISOString(),
          token: created.secret,
        });
      },
    );

    api.delete<{ Params: { id: string } }>(
      "/tokens/:id",
      {
        schema: {
          tags: ["tokens"],
          summary: "Revoke a Token",
          security,
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            204: { type: "null", description: "No Content" },
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "tokens:manage");
        if (!token) {
          return;
        }

        const revoked = await revokeToken(deps.db, request.params.id);
        if (isServiceError(revoked)) {
          return sendServiceError(reply, revoked);
        }
        return reply.code(204).send();
      },
    );

    api.get(
      "/me",
      {
        schema: {
          tags: ["tokens"],
          summary: "Inspect the authenticated Token",
          security,
          response: {
            200: {
              type: "object",
              additionalProperties: false,
              required: ["name", "prefix", "scopes", "createdAt"],
              properties: {
                name: { type: "string" },
                prefix: { type: "string" },
                scopes: { type: "array", items: { type: "string" } },
                createdAt: { type: "string" },
              },
            },
            401: problemSchema,
            403: problemSchema,
          },
        },
      },
      async (request, reply) => {
        const token = await requireToken(request, reply, deps, "drafts:read");
        if (!token) {
          return;
        }
        return {
          name: token.name,
          prefix: token.prefix,
          scopes: token.scopes,
          createdAt: token.createdAt.toISOString(),
        };
      },
    );
  }, { prefix: "/api/v1" });
}
