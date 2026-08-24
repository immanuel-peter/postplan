export const SECURITY_POLICY_VERSION = 1;

export const DRAFT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src *; frame-ancestors 'none'";

export const CURRENT_CACHE_CONTROL = "public, max-age=60, must-revalidate";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function currentEtag(draftId: string, currentVersion: number): string {
  return `"${draftId}-${currentVersion}"`;
}

export function versionEtag(sha256: string): string {
  return `"${sha256}"`;
}
