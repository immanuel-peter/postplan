import { ilike, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

const MAX_QUERY_CHARS = 200;

export function searchWords(raw: string | undefined): string[] {
  return (raw ?? "").slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean);
}

export function searchConditions(columns: [AnyColumn, ...AnyColumn[]], raw: string | undefined): SQL[] {
  return searchWords(raw).map((word) => {
    // One escape level only: the pattern binds as a parameter, so it is never
    // re-escaped as it would be inside a SQL string literal.
    const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
    return sql`(${sql.join(columns.map((column) => ilike(column, pattern)), sql` or `)})`;
  });
}
