import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";

export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
      await deps.s3.send(new HeadBucketCommand({ Bucket: deps.config.s3Bucket }));
      return {
        ok: true,
        postgres: "ok",
        garage: "ok",
        migration: deps.migrationVersion,
      };
    } catch (error) {
      return reply.code(503).send({
        ok: false,
        detail: error instanceof Error ? error.message : "not ready",
      });
    }
  });
}
