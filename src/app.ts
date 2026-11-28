import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import view from "@fastify/view";
import { Eta } from "eta";
import Fastify from "fastify";
import { ulid } from "ulid";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/client.js";
import { relyingParty } from "./lib/admin-auth.js";
import { registerAdminGuard } from "./lib/admin-guard.js";
import { registerErrorHandlers } from "./lib/errors.js";
import { sha256Hex } from "./lib/hash.js";
import { classifyHost, dashboardHostConstraint } from "./lib/host.js";
import { MAX_HTML_BYTES } from "./lib/html.js";
import { readTheme, themeCookieName } from "./lib/theme.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAssetPublicRoutes } from "./routes/assets-public.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPublicRoutes } from "./routes/public.js";
import { MAX_ASSET_BYTES, type AssetUrls } from "./services/assets.js";
import type { DraftUrls } from "./services/drafts.js";
import type { SessionRecord } from "./services/admin.js";
import type { TokenRecord } from "./services/types.js";

export type AppDeps = {
  config: AppConfig;
  db: Database;
  s3: S3Client;
  urls: DraftUrls;
  assetUrls: AssetUrls;
  migrationVersion: string;
};

declare module "fastify" {
  interface FastifyRequest {
    hostKind: ReturnType<typeof classifyHost>;
    apiToken: TokenRecord | null;
    adminSession: SessionRecord | null;
    adminCsrf: string | null;
  }
  interface FastifyReply {
    /** Merged into every `reply.view` by @fastify/view, which leaves it untyped. */
    locals: Record<string, unknown>;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: MAX_HTML_BYTES + 1024 * 1024,
    // Never trust a client-sent id: it ends up in logs and error bodies.
    requestIdHeader: false,
    genReqId: () => `req_${ulid()}`,
  });

  app.decorateRequest("hostKind", null);
  app.decorateRequest("apiToken", null);
  app.decorateRequest("adminSession", null);
  app.decorateRequest("adminCsrf", null);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Postplan API",
        version: "1.0.0",
        description: "Single-tenant HTML Draft publishing API",
      },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Token",
          },
        },
      },
    },
  });

  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: MAX_ASSET_BYTES,
      files: 1,
      fields: 16,
    },
    throwFileSizeLimit: true,
  });

  const css = readFileSync(join(here, "public", "app.css"), "utf8");
  const cssVersion = sha256Hex(Buffer.from(css, "utf8")).slice(0, 12);
  const viewsDir = join(here, "views");
  const eta = new Eta({ views: viewsDir, cache: deps.config.nodeEnv === "production" });
  function renderEta(filename: string, data: Record<string, unknown>): string {
    const normalized = filename.replaceAll("\\", "/");
    const fromViews = normalized.includes("/views/")
      ? (normalized.split("/views/").pop() ?? normalized)
      : normalized;
    const name = fromViews.replace(/\.eta$/, "");
    return eta.render(name, data);
  }
  await app.register(view, {
    engine: {
      eta: {
        configure() {
          return undefined;
        },
        render: renderEta,
        renderAsync(filename: string, data: Record<string, unknown>) {
          return Promise.resolve(renderEta(filename, data));
        },
        renderString(template: string, data: Record<string, unknown>) {
          return eta.renderString(template, data);
        },
        renderStringAsync(template: string, data: Record<string, unknown>) {
          return eta.renderStringAsync(template, data);
        },
      },
    },
    root: viewsDir,
    viewExt: "eta",
    propertyName: "view",
    defaultContext: { cssVersion },
  });

  registerErrorHandlers(app);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    request.hostKind = classifyHost(request.headers.host, deps.config.baseDomain);
    const path = request.url.split("?")[0] ?? "";
    if (path === "/healthz" || path === "/readyz") {
      return;
    }
    if (request.hostKind.kind === "reject") {
      return reply.code(404).type("text/plain").send("not found");
    }
  });

  const themeCookie = themeCookieName(relyingParty(deps.config));
  app.addHook("onRequest", async (request, reply) => {
    reply.locals = { ...reply.locals, theme: readTheme(request.headers.cookie, themeCookie) };
  });

  registerAdminGuard(app, deps);

  registerHealthRoutes(app, deps);
  await registerApiRoutes(app, deps);
  await registerAuthRoutes(app, deps);
  await registerPublicRoutes(app, deps);
  await registerAssetPublicRoutes(app, deps);
  await registerDashboardRoutes(app, deps);

  app.get("/openapi.json", async (_request, reply) => {
    return reply.type("application/json").send(app.swagger());
  });

  app.get("/static/app.css", async (_request, reply) => {
    return reply.type("text/css; charset=utf-8").send(css);
  });

  const webauthnJs = readFileSync(join(here, "public", "webauthn.js"), "utf8");
  app.get("/static/webauthn.js", async (_request, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(webauthnJs);
  });

  const localtimeJs = readFileSync(join(here, "public", "localtime.js"), "utf8");
  app.get("/static/localtime.js", async (_request, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(localtimeJs);
  });

  const tableSearchJs = readFileSync(join(here, "public", "table-search.js"), "utf8");
  app.get("/static/table-search.js", async (_request, reply) => {
    return reply.type("text/javascript; charset=utf-8").send(tableSearchJs);
  });

  const faviconSvg = readFileSync(join(here, "public", "favicon.svg"));
  const faviconIco = readFileSync(join(here, "public", "favicon.ico"));
  const touchIcon = readFileSync(join(here, "public", "apple-touch-icon.png"));
  app.get("/static/favicon.svg", async (_request, reply) => {
    return reply.type("image/svg+xml").send(faviconSvg);
  });
  app.get("/static/favicon.ico", async (_request, reply) => {
    return reply.type("image/x-icon").send(faviconIco);
  });
  app.get("/static/apple-touch-icon.png", async (_request, reply) => {
    return reply.type("image/png").send(touchIcon);
  });
  app.get("/favicon.ico", async (_request, reply) => {
    return reply.type("image/x-icon").send(faviconIco);
  });

  const pngs = ["icon-192.png", "icon-512.png", "icon-maskable-512.png"];
  for (const name of pngs) {
    const png = readFileSync(join(here, "public", name));
    app.get(`/static/${name}`, async (_request, reply) => {
      return reply.type("image/png").send(png);
    });
  }

  const offlineHtml = readFileSync(join(here, "public", "offline.html"), "utf8");
  app.get("/static/offline.html", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(offlineHtml);
  });

  const dashboardOnly = { constraints: { host: dashboardHostConstraint(deps.config.baseDomain) } };
  const manifest = readFileSync(join(here, "public", "manifest.webmanifest"), "utf8");
  app.get("/manifest.webmanifest", dashboardOnly, async (_request, reply) => {
    return reply.type("application/manifest+json; charset=utf-8").send(manifest);
  });

  const offlineVersion = sha256Hex(Buffer.from(offlineHtml, "utf8")).slice(0, 12);
  const serviceWorker = readFileSync(join(here, "public", "sw.js"), "utf8").replace("__OFFLINE_VERSION__", offlineVersion);
  app.get("/sw.js", dashboardOnly, async (_request, reply) => {
    return reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").send(serviceWorker);
  });

  return app;
}
