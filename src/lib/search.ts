import { and, ilike, or, type Column, type SQL } from "drizzle-orm";

/** Whitespace-separated words of a `q` value; `[]` means no filter. */
export function searchWords(q: string | undefined): string[] {
  return q ? q.split(/\s+/).filter(Boolean) : [];
}

/**
 * Every word must case-insensitively match at least one column.
 * `%`, `_`, and `\` in the input are escaped, so wildcards are literals.
 */
export function searchFilter<T extends Column>(words: string[], columns: T[]): SQL | undefined {
  if (words.length === 0) {
    return undefined;
  }
  return and(...words.map((word) => or(...columns.map((column) => ilike(column, `%${escapeLike(word)}%`)))));
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
