import { parse, type DefaultTreeAdapterMap } from "parse5";
import { sha256Hex } from "./hash.js";

type DocumentNode = DefaultTreeAdapterMap["document"];
type ChildNode = DefaultTreeAdapterMap["childNode"];

export const MAX_HTML_BYTES = 5 * 1024 * 1024;

export type HtmlValidationError = {
  status: 400;
  title: string;
  detail: string;
};

export type ValidHtml = {
  bytes: Buffer;
  sha256: string;
  byteSize: number;
};

export function isHtmlValidationError(
  value: ValidHtml | HtmlValidationError,
): value is HtmlValidationError {
  return "status" in value;
}

function isUtf8WithoutNul(bytes: Buffer): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !decoded.includes("\u0000");
  } catch {
    return false;
  }
}

function hasFullDocument(document: DocumentNode): boolean {
  const html = document.childNodes.find((node: ChildNode) => node.nodeName === "html");
  if (!html || !("childNodes" in html)) {
    return false;
  }
  return html.childNodes.some((node: ChildNode) => node.nodeName === "body");
}

export function validateHtml(bytes: Buffer): ValidHtml | HtmlValidationError {
  if (bytes.byteLength === 0) {
    return { status: 400, title: "Invalid HTML", detail: "html file is empty" };
  }
  if (bytes.byteLength > MAX_HTML_BYTES) {
    return {
      status: 400,
      title: "Payload too large",
      detail: `html exceeds ${MAX_HTML_BYTES} bytes`,
    };
  }
  if (!isUtf8WithoutNul(bytes)) {
    return {
      status: 400,
      title: "Invalid HTML",
      detail: "html must be valid UTF-8 without NUL bytes",
    };
  }

  const document = parse(bytes.toString("utf8"));
  if (!hasFullDocument(document)) {
    return {
      status: 400,
      title: "Invalid HTML",
      detail: "html must parse as a complete document",
    };
  }

  return {
    bytes,
    sha256: sha256Hex(bytes),
    byteSize: bytes.byteLength,
  };
}
