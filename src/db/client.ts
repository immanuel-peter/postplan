import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AppConfig } from "../config.js";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof createDb>["sql"];

export function createDb(config: AppConfig) {
  const sql = postgres(config.databaseUrl, { max: 10 });
  const db = drizzle(sql, { schema });
  return { sql, db };
}
