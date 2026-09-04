import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateSlug(): string {
  let n = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = `${ALPHABET[Number(n % 36n)]}${out}`;
    n /= 36n;
  }
  return out;
}

export const RESERVED_SLUGS = new Set(["assets"]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}
