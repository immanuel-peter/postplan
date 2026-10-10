export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readField(body: unknown, key: string): string | null {
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

export function parseVersionNumber(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  return n;
}

export function matchesEtag(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
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
