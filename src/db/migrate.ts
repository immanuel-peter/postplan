import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadConfig } from "../config.js";

const folder = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");

async function main() {
  const config = loadConfig();
  const sql = postgres(config.databaseUrl, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: folder });
  await sql.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
