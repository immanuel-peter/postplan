import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createS3, ensureBucket } from "./lib/s3.js";
import { buildApp } from "./app.js";
import { assetUrls } from "./services/assets.js";
import { draftUrls } from "./services/drafts.js";
import { cleanupOrphans } from "./services/orphans.js";
import { seedBootstrapToken } from "./services/tokens.js";

async function main() {
  const config = loadConfig();
  const { db, sql } = createDb(config);
  const s3 = createS3(config);
  await ensureBucket(s3, config.s3Bucket);
  await seedBootstrapToken({
    db,
    pepper: config.tokenPepper,
    bootstrapToken: config.bootstrapToken,
  });

  const app = await buildApp({
    config,
    db,
    s3,
    urls: draftUrls({
      baseDomain: config.baseDomain,
      port: config.port,
      nodeEnv: config.nodeEnv,
    }),
    assetUrls: assetUrls({
      baseDomain: config.baseDomain,
      port: config.port,
      nodeEnv: config.nodeEnv,
    }),
    migrationVersion: "0003_powerful_mentor",
  });

  const close = async () => {
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void close();
  });
  process.on("SIGTERM", () => {
    void close();
  });

  await cleanupOrphans({ db, s3, bucket: config.s3Bucket });
  setInterval(() => {
    void cleanupOrphans({ db, s3, bucket: config.s3Bucket });
  }, 60 * 60 * 1000).unref();

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
