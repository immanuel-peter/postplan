export const SECURITY_POLICY_VERSION = 2;

export function draftCsp(assetOrigin: string): string {
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob: ${assetOrigin}; media-src 'self' data: blob: ${assetOrigin}; connect-src *; frame-ancestors 'none'`;
}

export const ASSET_DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const CURRENT_CACHE_CONTROL = "public, max-age=60, must-revalidate";
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function currentEtag(draftId: string, currentVersion: number): string {
  return `"${draftId}-${currentVersion}"`;
}

export function versionEtag(sha256: string): string {
  return `"${sha256}"`;
}
