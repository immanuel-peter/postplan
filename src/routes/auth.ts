import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import {
  CHALLENGE_TTL_MS,
  SESSION_TTL_MS,
  challengeCookieName,
  createRateLimiter,
  sessionCookieName,
  readCookie,
  relyingParty,
  serializeCookie,
  type RelyingParty,
} from "../lib/admin-auth.js";
import { dashboardHostConstraint, isDashboardHostKind } from "../lib/host.js";
import { formatStamp } from "../lib/time.js";
import { hashToken, hashesEqual } from "../lib/tokens.js";
import {
  addCredential,
  authenticateSession,
  consumeChallenge,
  createChallenge,
  createSession,
  enrollFirstCredential,
  enrollRecoveryCredential,
  findCredential,
  listCredentials,
  listSessions,
  markCredentialUsed,
  removeCredential,
  revokeAllSessions,
  revokeSession,
  setupState,
  type ChallengeOperation,
} from "../services/admin.js";

/** One admin identity: a fixed WebAuthn user handle, no owner table (ADR 0008). */
const ADMIN_USER_ID = new TextEncoder().encode("postplan-admin");
const ADMIN_USER_NAME = "admin";

type IdParams = { id: string };

const setupLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
const unlockLimiter = createRateLimiter({ limit: 30, windowMs: 15 * 60 * 1000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(body: unknown, key: string): string | null {
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

export function csrfToken(sessionId: string, pepper: string): string {
  return hashToken(`csrf:${sessionId}`, pepper);
}

/**
 * Drafts run untrusted JavaScript on sibling subdomains, which are same-site: `SameSite=Lax` alone
 * does not keep them out, so every browser mutation needs an exact-origin match too.
 */
function allowedOrigins(rp: RelyingParty, port: number): string[] {
  if (rp.secure) {
    return [rp.origin];
  }
  return [rp.origin, `http://localhost:${String(port)}`, `http://127.0.0.1:${String(port)}`];
}

function originAllowed(request: FastifyRequest, origins: string[]): boolean {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    return origins.includes(origin);
  }
  const referer = request.headers.referer;
  if (typeof referer === "string" && referer !== "") {
    try {
      return origins.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

function clientKey(request: FastifyRequest): string {
  return request.ip;
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'");
}

function safeNext(raw: string | undefined): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/";
  }
  return raw;
}

function setChallengeCookie(reply: FastifyReply, rp: RelyingParty, id: string): void {
  reply.header(
    "Set-Cookie",
    serializeCookie(challengeCookieName(rp), id, {
      maxAge: Math.floor(CHALLENGE_TTL_MS / 1000),
      secure: rp.secure,
    }),
  );
}

function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAge: 0, secure });
}

function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Firefox\//.test(ua)
    ? "Firefox"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Mac OS X/.test(ua)
    ? "macOS"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "unknown";
  return `${browser} · ${os}`;
}

function expiresLabel(expiresAt: Date): string {
  const days = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "in 1 day" : `in ${String(days)} days`;
}

function problem(reply: FastifyReply, status: number, detail: string): FastifyReply {
  return reply.code(status).type("application/json").send({ error: detail });
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const rp = relyingParty(deps.config);
  const origins = allowedOrigins(rp, deps.config.port);
  const dashboardOnly = { constraints: { host: dashboardHostConstraint(deps.config.baseDomain) } };
  const sessionCookie = sessionCookieName(rp);
  const challengeCookie = challengeCookieName(rp);

  function renderUnlock(
    reply: FastifyReply,
    extra: { error: string | null; next: string; recoverable: boolean },
  ): unknown {
    noStore(reply);
    return reply.view("auth/unlock", {
      title: "Unlock",
      error: extra.error,
      next: extra.next,
      recoverable: extra.recoverable,
    });
  }

  app.get("/unlock", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    const state = await setupState(deps.db);
    if (!state.closed) {
      return reply.redirect("/setup");
    }
    if (request.adminSession) {
      return reply.redirect("/");
    }
    const next = safeNext((request.query as Record<string, string> | undefined)?.next);
    return renderUnlock(reply, {
      error: null,
      next,
      recoverable: deps.config.adminRecoverySecret !== null,
    });
  });

  app.get("/setup", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    const state = await setupState(deps.db);
    const mode = setupMode(state, deps);
    if (mode === null) {
      return reply.redirect("/unlock");
    }
    return reply.view("auth/setup", {
      title: mode === "recovery" ? "Recover access" : "Set up PostPlan",
      mode,
      error: null,
    });
  });

  app.post("/setup", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    if (!originAllowed(request, origins)) {
      return reply.code(403).type("text/plain").send("bad origin");
    }
    const state = await setupState(deps.db);
    const mode = setupMode(state, deps);
    if (mode === null) {
      return reply.redirect("/unlock");
    }
    if (!setupLimiter.check(clientKey(request))) {
      return reply.code(429).view("auth/setup", {
        title: "Set up PostPlan",
        mode,
        error: "Too many attempts. Wait a few minutes and try again.",
      });
    }
    const supplied = readField(request.body, "secret");
    const expected =
      mode === "recovery" ? deps.config.adminRecoverySecret : deps.config.adminSetupSecret;
    if (
      supplied === null ||
      expected === null ||
      !hashesEqual(
        hashToken(supplied, deps.config.tokenPepper),
        hashToken(expected, deps.config.tokenPepper),
      )
    ) {
      return reply.code(400).view("auth/setup", {
        title: mode === "recovery" ? "Recover access" : "Set up PostPlan",
        mode,
        error: "That secret didn't match.",
      });
    }

    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: ADMIN_USER_NAME,
      userID: ADMIN_USER_ID,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const operation: ChallengeOperation = mode === "recovery" ? "register_recovery" : "register_setup";
    const id = await createChallenge(deps.db, operation, options.challenge);
    setChallengeCookie(reply, rp, id);
    return reply.view("auth/enroll", {
      title: "Add your passkey",
      mode,
      options: JSON.stringify(options),
    });
  });

  app.post("/auth/login/options", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    if (!originAllowed(request, origins)) {
      return problem(reply, 403, "bad origin");
    }
    if (!unlockLimiter.check(clientKey(request))) {
      return problem(reply, 429, "too many attempts");
    }
    const credentials = await listCredentials(deps.db);
    if (credentials.length === 0) {
      return problem(reply, 409, "no passkey enrolled");
    }
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
    });
    const id = await createChallenge(deps.db, "authenticate", options.challenge);
    setChallengeCookie(reply, rp, id);
    return reply.send(options);
  });

  app.post("/auth/login/verify", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    if (!originAllowed(request, origins)) {
      return problem(reply, 403, "bad origin");
    }
    const challengeId = readCookie(request.headers.cookie, challengeCookie);
    if (challengeId === null) {
      return problem(reply, 400, "challenge expired");
    }
    const expectedChallenge = await consumeChallenge(deps.db, challengeId, "authenticate");
    if (expectedChallenge === null) {
      return problem(reply, 400, "challenge expired");
    }
    const response = request.body as AuthenticationResponseJSON | undefined;
    if (!response || typeof response.id !== "string") {
      return problem(reply, 400, "malformed response");
    }
    const credential = await findCredential(deps.db, response.id);
    if (!credential) {
      return problem(reply, 401, "unknown passkey");
    }

    let verified = false;
    let newCounter = credential.counter;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, "base64url"),
          counter: credential.counter,
          transports: credential.transports,
        },
      });
      verified = result.verified;
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      verified = false;
    }
    if (!verified) {
      return problem(reply, 401, "verification failed");
    }

    await markCredentialUsed(deps.db, credential.id, newCounter);
    const session = await createSession({
      db: deps.db,
      pepper: deps.config.tokenPepper,
      userAgent: request.headers["user-agent"] ?? null,
    });
    reply.header("Set-Cookie", [
      clearCookie(challengeCookie, rp.secure),
      serializeCookie(sessionCookie, session.token, {
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: rp.secure,
      }),
    ]);
    return reply.send({ ok: true });
  });

  app.post("/auth/register/options", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    if (!originAllowed(request, origins)) {
      return problem(reply, 403, "bad origin");
    }
    if (!request.adminSession) {
      return problem(reply, 401, "locked");
    }
    if (readField(request.body, "_csrf") !== request.adminCsrf) {
      return problem(reply, 403, "bad csrf");
    }
    const credentials = await listCredentials(deps.db);
    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: ADMIN_USER_NAME,
      userID: ADMIN_USER_ID,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports,
      })),
    });
    const id = await createChallenge(deps.db, "register_add", options.challenge);
    setChallengeCookie(reply, rp, id);
    return reply.send(options);
  });

  app.post("/auth/register/verify", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    if (!originAllowed(request, origins)) {
      return problem(reply, 403, "bad origin");
    }
    const challengeId = readCookie(request.headers.cookie, challengeCookie);
    if (challengeId === null) {
      return problem(reply, 400, "challenge expired");
    }
    const body = request.body as
      | { credential?: RegistrationResponseJSON; name?: string; _csrf?: string }
      | undefined;
    const response = body?.credential;
    if (!response || typeof response.id !== "string") {
      return problem(reply, 400, "malformed response");
    }
    const name = body?.name?.trim() ?? "";

    const operation = await resolveRegisterOperation(deps, challengeId);
    if (operation === null) {
      return problem(reply, 400, "challenge expired");
    }
    if (operation.operation === "register_add") {
      if (!request.adminSession) {
        return problem(reply, 401, "locked");
      }
      if (body?._csrf !== request.adminCsrf) {
        return problem(reply, 403, "bad csrf");
      }
    }

    let credentialId: string;
    let publicKey: string;
    let counter: number;
    let transports: string[];
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: operation.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
      if (!result.verified) {
        return problem(reply, 400, "verification failed");
      }
      credentialId = result.registrationInfo.credential.id;
      publicKey = Buffer.from(result.registrationInfo.credential.publicKey).toString("base64url");
      counter = result.registrationInfo.credential.counter;
      transports = result.registrationInfo.credential.transports ?? [];
    } catch {
      return problem(reply, 400, "verification failed");
    }

    const record = { credentialId, publicKey, counter, transports, name: name === "" ? "Passkey" : name };
    if (operation.operation === "register_setup") {
      const created = await enrollFirstCredential(deps.db, record);
      if (!created) {
        return problem(reply, 409, "setup already completed");
      }
    } else if (operation.operation === "register_recovery") {
      const recoverySecret = deps.config.adminRecoverySecret;
      if (recoverySecret === null) {
        return problem(reply, 409, "recovery not available");
      }
      const created = await enrollRecoveryCredential(deps.db, {
        ...record,
        pepper: deps.config.tokenPepper,
        recoverySecret,
      });
      if (!created) {
        return problem(reply, 409, "recovery secret already used");
      }
    } else {
      await addCredential(deps.db, record);
      reply.header("Set-Cookie", clearCookie(challengeCookie, rp.secure));
      return reply.send({ ok: true });
    }

    const session = await createSession({
      db: deps.db,
      pepper: deps.config.tokenPepper,
      userAgent: request.headers["user-agent"] ?? null,
    });
    reply.header("Set-Cookie", [
      clearCookie(challengeCookie, rp.secure),
      serializeCookie(sessionCookie, session.token, {
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        secure: rp.secure,
      }),
    ]);
    return reply.send({ ok: true });
  });

  app.post("/lock", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    if (request.adminSession) {
      await revokeSession(deps.db, request.adminSession.id);
    }
    reply.header("Set-Cookie", clearCookie(sessionCookie, rp.secure));
    return reply.redirect("/unlock");
  });

  app.get("/security", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    noStore(reply);
    return renderSecurity(reply, deps, request);
  });

  app.post<{ Params: IdParams }>(
    "/security/passkeys/:id/delete",
    dashboardOnly,
    async (request, reply) => {
      if (!isDashboardHostKind(request.hostKind.kind)) {
        return;
      }
      const removed = await removeCredential(deps.db, request.params.id);
      if (!removed) {
        return reply.code(404).type("text/plain").send("not found");
      }
      return reply.redirect("/security");
    },
  );

  app.post<{ Params: IdParams }>(
    "/security/sessions/:id/revoke",
    dashboardOnly,
    async (request, reply) => {
      if (!isDashboardHostKind(request.hostKind.kind)) {
        return;
      }
      await revokeSession(deps.db, request.params.id);
      if (request.adminSession?.id === request.params.id) {
        reply.header("Set-Cookie", clearCookie(sessionCookie, rp.secure));
        return reply.redirect("/unlock");
      }
      return reply.redirect("/security");
    },
  );

  app.post("/security/sessions/revoke-all", dashboardOnly, async (request, reply) => {
    if (!isDashboardHostKind(request.hostKind.kind)) {
      return;
    }
    await revokeAllSessions(deps.db);
    reply.header("Set-Cookie", clearCookie(sessionCookie, rp.secure));
    return reply.redirect("/unlock");
  });

  async function renderSecurity(
    reply: FastifyReply,
    appDeps: AppDeps,
    request: FastifyRequest,
  ): Promise<unknown> {
    const [credentials, sessions] = await Promise.all([
      listCredentials(appDeps.db),
      listSessions(appDeps.db),
    ]);
    return reply.view("auth/security", {
      title: "Security",
      active: "security",
      csrf: request.adminCsrf,
      passkeys: credentials.map((credential) => ({
        id: credential.id,
        name: credential.name,
        transports: credential.transports.join(", "),
        createdLabel: formatStamp(credential.createdAt),
        lastUsedLabel: formatStamp(credential.lastUsedAt),
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        label: deviceLabel(session.userAgent),
        current: session.id === request.adminSession?.id,
        createdLabel: formatStamp(session.createdAt),
        expiresLabel: expiresLabel(session.expiresAt),
      })),
    });
  }
}

function setupMode(
  state: { closed: boolean; recoveryConsumedHash: string | null },
  deps: AppDeps,
): "setup" | "recovery" | null {
  if (!state.closed) {
    return deps.config.adminSetupSecret === null ? null : "setup";
  }
  const recovery = deps.config.adminRecoverySecret;
  if (recovery === null) {
    return null;
  }
  const hash = hashToken(recovery, deps.config.tokenPepper);
  if (state.recoveryConsumedHash !== null && hashesEqual(state.recoveryConsumedHash, hash)) {
    return null;
  }
  return "recovery";
}

async function resolveRegisterOperation(
  deps: AppDeps,
  challengeId: string,
): Promise<{ operation: ChallengeOperation; challenge: string } | null> {
  for (const operation of ["register_setup", "register_recovery", "register_add"] as const) {
    const challenge = await consumeChallenge(deps.db, challengeId, operation);
    if (challenge !== null) {
      return { operation, challenge };
    }
  }
  return null;
}
