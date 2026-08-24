import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ALL_SCOPES = [
  "drafts:read",
  "drafts:write",
  "drafts:delete",
  "tokens:manage",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (ALL_SCOPES as readonly string[]).includes(value);
}

export function hashToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 11);
}

export function generateTokenSecret(): string {
  return `pp_${randomBytes(24).toString("base64url")}`;
}

export function parseScopes(input: unknown): Scope[] {
  if (!Array.isArray(input)) {
    throw new Error("scopes must be an array");
  }
  const scopes: Scope[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !isScope(item)) {
      throw new Error(`unknown scope: ${String(item)}`);
    }
    if (!scopes.includes(item)) {
      scopes.push(item);
    }
  }
  if (scopes.length === 0) {
    throw new Error("scopes must not be empty");
  }
  return scopes;
}
