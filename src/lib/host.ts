export type HostKind =
  | { kind: "apex" }
  | { kind: "assets" }
  | { kind: "draft"; slug: string }
  | { kind: "local" }
  | { kind: "reject" };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function hostnameFromHeader(hostHeader: string | undefined): string {
  if (!hostHeader) {
    return "";
  }
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader.toLowerCase() : hostHeader.slice(1, end).toLowerCase();
  }
  const colon = hostHeader.lastIndexOf(":");
  if (colon > -1 && hostHeader.slice(colon + 1).match(/^\d+$/)) {
    return hostHeader.slice(0, colon).toLowerCase();
  }
  return hostHeader.toLowerCase();
}

export function classifyHost(hostHeader: string | undefined, baseDomain: string): HostKind {
  const hostname = hostnameFromHeader(hostHeader);
  const base = baseDomain.toLowerCase();

  if (LOCAL_HOSTS.has(hostname)) {
    return { kind: "local" };
  }
  if (hostname === base) {
    return { kind: "apex" };
  }
  if (hostname === `assets.${base}`) {
    return { kind: "assets" };
  }
  if (hostname.endsWith(`.${base}`)) {
    const slug = hostname.slice(0, hostname.length - (base.length + 1));
    if (slug.length > 0 && !slug.includes(".")) {
      return { kind: "draft", slug };
    }
  }
  return { kind: "reject" };
}

export function publicDraftUrl(baseDomain: string, slug: string, version?: number): string {
  const origin = `https://${slug}.${baseDomain}`;
  if (version === undefined) {
    return `${origin}/`;
  }
  return `${origin}/v/${version}`;
}

export function localDraftUrl(slug: string, port: number, version?: number): string {
  const origin = `http://${slug}.postplan.localhost:${port}`;
  if (version === undefined) {
    return `${origin}/`;
  }
  return `${origin}/v/${version}`;
}

export function publicAssetUrl(baseDomain: string, id: string, ext?: string | undefined): string {
  const suffix = ext ? `.${ext}` : "";
  return `https://assets.${baseDomain}/${id}${suffix}`;
}

export function localAssetUrl(port: number, id: string, ext?: string | undefined): string {
  const suffix = ext ? `.${ext}` : "";
  return `http://assets.postplan.localhost:${port}/${id}${suffix}`;
}
