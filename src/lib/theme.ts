import { readCookie, type RelyingParty } from "./admin-auth.js";

export const THEMES = ["light", "dark", "system"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function themeCookieName(rp: RelyingParty): string {
  return rp.secure ? "__Host-postplan_theme" : "postplan_theme";
}

export function parseTheme(value: unknown): Theme | null {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value) ? (value as Theme) : null;
}

/** No cookie or an unknown value follows the OS. */
export function readTheme(cookieHeader: string | undefined, cookieName: string): Theme {
  return parseTheme(readCookie(cookieHeader, cookieName)) ?? "system";
}
