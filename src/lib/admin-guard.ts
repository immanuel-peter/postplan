import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { readCookie, relyingParty, sessionCookieName } from "./admin-auth.js";
import { isDashboardHostKind } from "./host.js";
import { hashToken, hashesEqual } from "./tokens.js";
import { authenticateSession, setupState } from "../services/admin.js";

/**
 * Routes that consume a multipart body and therefore check `_csrf` themselves, because Fastify
 * cannot parse the body before the handler runs. Anything not listed here is rejected when sent as
 * multipart, so a new multipart route fails closed until it does its own check.
 */
const MULTIPART_CSRF_ROUTES = new Set(["/assets"]);

const OPEN_PATHS = new Set([
  "/healthz",
  "/readyz",
  "/openapi.json",
  "/favicon.ico",
  "/unlock",
  "/setup",
  "/auth/login/options",
  "/auth/login/verify",
  "/auth/register/options",
  "/auth/register/verify",
]);

function isOpen(path: string): boolean {
  return OPEN_PATHS.has(path) || path.startsWith("/static/") || path.startsWith("/api/v1");
}

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function bodyCsrf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const value = (body as Record<string, unknown>)._csrf;
  return typeof value === "string" ? value : null;
}

/**
 * Gate every dashboard read and write on a session before the route handler runs. Public Drafts,
 * the assets host, and `/api/v1` bearer auth are untouched.
 */
export function registerAdminGuard(app: FastifyInstance, deps: AppDeps): void {
  const rp = relyingParty(deps.config);
  const cookieName = sessionCookieName(rp);
  const origins = rp.secure
    ? [rp.origin]
    : [
        rp.origin,
        `http://localhost:${String(deps.config.port)}`,
        `http://127.0.0.1:${String(deps.config.port)}`,
      ];

  app.addHook("onRequest", async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/api/v1")) {
      return;
    }

    // WebAuthn is pinned to the configured origin, so `localhost` and `127.0.0.1` can never complete
    // a ceremony: the RP ID is not a suffix of those hosts. Send browsers to the canonical origin
    // instead of letting them dead-end. Health and static paths still answer on any alias.
    if (
      request.hostKind.kind === "local" &&
      isRead(request.method) &&
      !path.startsWith("/static/") &&
      path !== "/healthz" &&
      path !== "/readyz"
    ) {
      return reply.redirect(`${rp.origin}${request.url}`);
    }

    const token = readCookie(request.headers.cookie, cookieName);
    if (token !== null) {
      const session = await authenticateSession({
        db: deps.db,
        pepper: deps.config.tokenPepper,
        token,
      });
      if (session) {
        request.adminSession = session;
        request.adminCsrf = hashToken(`csrf:${session.id}`, deps.config.tokenPepper);
      }
    }

    if (isOpen(path)) {
      return;
    }

    reply.header("Cache-Control", "no-store");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");

    if (!request.adminSession) {
      if (!isRead(request.method)) {
        return reply.code(403).type("text/plain").send("locked");
      }
      const state = await setupState(deps.db);
      if (!state.closed) {
        return reply.redirect("/setup");
      }
      return reply.redirect(`/unlock?next=${encodeURIComponent(request.url)}`);
    }

    if (!isRead(request.method)) {
      const origin = request.headers.origin;
      const allowed =
        typeof origin === "string" && origin !== ""
          ? origins.includes(origin)
          : refererAllowed(request.headers.referer, origins);
      if (!allowed) {
        return reply.code(403).type("text/plain").send("bad origin");
      }
    }
  });

  /** Form bodies are parsed after `onRequest`, so CSRF is checked once the body exists. */
  app.addHook("preHandler", async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    const path = request.url.split("?")[0] ?? "";
    if (isOpen(path) || isRead(request.method) || !request.adminSession) {
      return;
    }
    if (request.isMultipart()) {
      // The content type is attacker-controlled, so this must key off the route, not the request:
      // otherwise any dashboard mutation could skip CSRF just by claiming to be multipart.
      if (!MULTIPART_CSRF_ROUTES.has(path)) {
        return reply.code(403).type("text/plain").send("bad csrf");
      }
      return;
    }
    const supplied = bodyCsrf(request.body);
    const expected = request.adminCsrf;
    if (supplied === null || expected === null || !hashesEqual(supplied, expected)) {
      return reply.code(403).type("text/plain").send("bad csrf");
    }
  });
}

function refererAllowed(referer: string | undefined, origins: string[]): boolean {
  if (typeof referer !== "string" || referer === "") {
    return false;
  }
  try {
    return origins.includes(new URL(referer).origin);
  } catch {
    return false;
  }
}
