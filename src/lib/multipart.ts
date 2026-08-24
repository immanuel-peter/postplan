import type { FastifyRequest } from "fastify";
import { MAX_HTML_BYTES } from "./html.js";

export type MultipartFields = {
  html: Buffer | null;
  filename: string | null;
  fields: Record<string, string>;
};

export async function readMultipart(request: FastifyRequest): Promise<MultipartFields> {
  const fields: Record<string, string> = {};
  let html: Buffer | null = null;
  let filename: string | null = null;

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (part.fieldname !== "html") {
        await part.toBuffer();
        continue;
      }
      const bytes = await part.toBuffer();
      if (bytes.byteLength > MAX_HTML_BYTES) {
        throw Object.assign(new Error("html exceeds 5 MiB"), { statusCode: 413 });
      }
      html = bytes;
      filename = part.filename || null;
    } else {
      fields[part.fieldname] = part.value as string;
    }
  }

  return { html, filename, fields };
}

export function optionalField(fields: Record<string, string>, name: string): string | null | undefined {
  if (!(name in fields)) {
    return undefined;
  }
  const value = fields[name]?.trim() ?? "";
  return value.length === 0 ? null : value;
}

export function parseExpectedVersion(input: {
  header?: string;
  field?: string;
}): number | null {
  const raw = input.header?.trim() || input.field?.trim() || "";
  if (!raw) {
    return null;
  }
  const unquoted = raw.replace(/^"+|"+$/g, "");
  const n = Number.parseInt(unquoted, 10);
  if (!Number.isInteger(n) || n < 1) {
    return null;
  }
  return n;
}
