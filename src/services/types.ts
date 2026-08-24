import type { Scope } from "../lib/tokens.js";

export type DraftStatus = "active" | "deleted";

export type DraftRecord = {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  status: DraftStatus;
  currentVersion: number;
  repositoryUrl: string | null;
  repositoryName: string | null;
  gitRef: string | null;
  gitCommit: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export type VersionRecord = {
  draftId: string;
  versionNumber: number;
  objectKey: string;
  contentSha256: string;
  byteSize: number;
  gitRef: string | null;
  gitCommit: string | null;
  sourceFilename: string | null;
  securityPolicyVersion: number;
  createdAt: Date;
};

export type TokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type DraftResponse = {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  status: DraftStatus;
  currentVersion: number;
  publicUrl: string;
  versionUrl: string;
  contentSha256: string;
  byteSize: number;
  repositoryUrl: string | null;
  repositoryName: string | null;
  gitRef: string | null;
  gitCommit: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ServiceError = {
  kind: "not_found" | "conflict" | "gone" | "validation" | "precondition";
  title: string;
  detail: string;
  currentVersion?: number;
};

export function isServiceError(value: unknown): value is ServiceError {
  return typeof value === "object" && value !== null && "kind" in value && "title" in value;
}
