import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import view from "@fastify/view";
import { Eta } from "eta";
import Fastify from "fastify";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/client.js";
import { MAX_HTML_BYTES } from "./lib/html.js";
import { classifyHost } from "./lib/host.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPublicRoutes } from "./routes/public.js";
import type { DraftUrls } from "./services/drafts.js";
import type { TokenRecord } from "./services/types.js";

export type AppDeps = {
  config: AppConfig;
  db: Database;
  s3: S3Client;
  urls: DraftUrls;
  migrationVersion: string;
};

declare module "fastify" {
  interface FastifyRequest {
    hostKind: ReturnType<typeof classifyHost>;
    apiToken: TokenRecord | null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: MAX_HTML_BYTES,
  });

  app.decorateRequest("hostKind", null);
  app.decorateRequest("apiToken", null);

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "PostPlan API",
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
      fileSize: MAX_HTML_BYTES,
      files: 1,
      fields: 16,
    },
    throwFileSizeLimit: true,
  });

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
  });

  app.addHook("onRequest", async (request, reply) => {
    request.hostKind = classifyHost(request.headers.host, deps.config.baseDomain);
    const path = request.url.split("?")[0] ?? "";
    if (path === "/healthz" || path === "/readyz") {
      return;
    }
    if (request.hostKind.kind === "reject") {
      return reply.code(404).type("text/plain").send("not found");
    }
  });

  registerHealthRoutes(app, deps);
  await registerApiRoutes(app, deps);
  await registerPublicRoutes(app, deps);
  await registerDashboardRoutes(app, deps);

  app.get("/openapi.json", async (_request, reply) => {
    return reply.type("application/json").send(app.swagger());
  });

  const css = readFileSync(join(here, "public", "app.css"), "utf8");
  app.get("/static/app.css", async (_request, reply) => {
    return reply.type("text/css; charset=utf-8").send(css);
  });

  return app;
}
