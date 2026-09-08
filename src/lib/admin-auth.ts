import { randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type RelyingParty = {
  id: string;
  name: string;
  origin: string;
  secure: boolean;
};

export function relyingParty(config: AppConfig): RelyingParty {
  const local = config.nodeEnv === "development" || config.baseDomain.endsWith(".localhost");
  return {
    id: config.baseDomain,
    name: "PostPlan",
    origin: local
      ? `http://${config.baseDomain}:${String(config.port)}`
      : `https://${config.baseDomain}`,
    secure: !local,
  };
}

export function sessionCookieName(rp: RelyingParty): string {
  return rp.secure ? "__Host-postplan_session" : "postplan_session";
}

export function challengeCookieName(rp: RelyingParty): string {
  return rp.secure ? "__Host-postplan_challenge" : "postplan_challenge";
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(options.maxAge)}`,
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Sliding-window limiter keyed by client address; setup and unlock attempts are cheap to spam. */
export function createRateLimiter(input: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return {
    check(key: string): boolean {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((at) => now - at < input.windowMs);
      if (recent.length >= input.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}
