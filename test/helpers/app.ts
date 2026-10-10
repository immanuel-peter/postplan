import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { buildApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import * as schema from "../../src/db/schema.js";
import type { Database } from "../../src/db/client.js";
import { assetUrls } from "../../src/services/assets.js";
import { draftUrls } from "../../src/services/drafts.js";
import { seedBootstrapToken } from "../../src/services/tokens.js";
import { FakeS3 } from "./fake-s3.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

export const BASE_DOMAIN = "postplan.test";
export const BOOTSTRAP_TOKEN = "pp_test_bootstrap_token";
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set in CI so integration tests cannot silently skip");
}

/** Integration tests need Postgres; locally they are skipped rather than failed without it. */
export const skipWithoutDb = TEST_DATABASE_URL
  ? false
  : "TEST_DATABASE_URL is not set; skipping Postgres-backed tests";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    port: 3000,
    baseDomain: BASE_DOMAIN,
    databaseUrl: "",
    s3EndpointUrl: "http://s3.invalid",
    s3Region: "garage",
    s3Bucket: "postplan",
    s3AddressingStyle: "path",
    s3AccessKeyId: "test",
    s3SecretAccessKey: "test",
    tokenPepper: "test-pepper",
    bootstrapToken: BOOTSTRAP_TOKEN,
    openapiPublic: true,
    adminSetupSecret: "test-setup-secret",
    adminRecoverySecret: null,
    ...overrides,
  };
}

export type TestApp = Awaited<ReturnType<typeof startTestApp>>;

/**
 * Builds the real app against a throwaway database (one per test file, so files can run in
 * parallel) and an in-memory S3. Call `close()` in an `after` hook.
 */
export async function startTestApp(overrides: Partial<AppConfig> = {}) {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required");
  }
  const dbName = `postplan_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${dbName}`;
  const sql = postgres(url.toString(), { max: 5, onnotice: () => {} });
  const db: Database = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder });

  const config = testConfig({ ...overrides, databaseUrl: url.toString() });
  const s3 = new FakeS3(config.s3Bucket);
  await seedBootstrapToken({ db, pepper: config.tokenPepper, bootstrapToken: config.bootstrapToken });

  const app = await buildApp({
    config,
    db,
    s3: s3.asClient(),
    urls: draftUrls({ baseDomain: config.baseDomain, port: config.port, nodeEnv: config.nodeEnv }),
    assetUrls: assetUrls({ baseDomain: config.baseDomain, port: config.port, nodeEnv: config.nodeEnv }),
    migrationVersion: "test",
  });
  // Fastify's logger is on in the real app; keep test output readable.
  app.log.level = "silent";
  await app.ready();

  return {
    app,
    db,
    s3,
    config,
    async close() {
      await app.close();
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    },
  };
}

export const auth = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };

export function apiHost(): { host: string } {
  return { host: BASE_DOMAIN };
}

export function draftHost(slug: string): { host: string } {
  return { host: `${slug}.${BASE_DOMAIN}` };
}

export function assetsHost(): { host: string } {
  return { host: `assets.${BASE_DOMAIN}` };
}

export function htmlDoc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
}

/** Builds a multipart body by hand so tests don't pull in a form-data dependency. */
export function multipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; data: Buffer | string }
  >,
): { payload: Buffer; headers: { "content-type": string } } {
  const boundary = `----postplan${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("filename" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
