import { parse, type DefaultTreeAdapterMap } from "parse5";
import { sha256Hex } from "./hash.js";
import { OG_HEIGHT, OG_WIDTH } from "./og-card.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const HTML_NS = "http://www.w3.org/1999/xhtml";
const UNTITLED = "Untitled draft";
// Bump when the injected tags change so cached Draft HTML gets a new ETag.
const LINK_PREVIEW_REVISION = 1;

export type PreviewText = { title: string; description: string | null };

export type LinkPreview = {
  title: string | null;
  description: string | null;
  pageUrl: string;
  imageUrl: string;
};

type DocumentScan = {
  meta: Map<string, string>;
  title: string | null;
  insertAt: number;
};

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function attr(element: Element, name: string): string | undefined {
  return element.attrs.find((a) => a.name === name)?.value;
}

function clean(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  return text === "" ? null : text;
}

function scanDocument(html: string): DocumentScan {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const meta = new Map<string, string>();
  let title: string | null = null;

  const stack: Node[] = [...document.childNodes].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (!isElement(node)) {
      continue;
    }
    if (node.tagName === "meta") {
      const key = (attr(node, "property") ?? attr(node, "name"))?.trim().toLowerCase();
      if (key && !meta.has(key)) {
        meta.set(key, attr(node, "content") ?? "");
      }
    } else if (node.tagName === "title" && node.namespaceURI === HTML_NS && title === null) {
      title = clean(node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""));
    }
    stack.push(...[...node.childNodes].reverse());
  }

  const root = document.childNodes.find((n): n is Element => isElement(n) && n.tagName === "html");
  const head = root?.childNodes.find((n): n is Element => isElement(n) && n.tagName === "head");
  const doctype = document.childNodes.find((n) => n.nodeName === "#documentType");
  const insertAt =
    head?.sourceCodeLocation?.startTag?.endOffset ??
    root?.sourceCodeLocation?.startTag?.endOffset ??
    doctype?.sourceCodeLocation?.endOffset ??
    0;

  return { meta, title, insertAt };
}

/** What a preview shows: the Draft's own fields first, then what the HTML says about itself. */
export function previewText(
  draft: { title: string | null; description: string | null },
  html: string | null,
): PreviewText {
  const title = clean(draft.title);
  const description = clean(draft.description);
  if (title !== null && description !== null) {
    return { title, description };
  }
  const scan = html === null ? null : scanDocument(html);
  return {
    title: title ?? clean(scan?.meta.get("og:title")) ?? scan?.title ?? UNTITLED,
    description: description ?? clean(scan?.meta.get("og:description")) ?? clean(scan?.meta.get("description")),
  };
}

/** Changes whenever the tags injected for this Draft would change without a new Version. */
export function previewFingerprint(draft: { title: string | null; description: string | null }): string {
  return sha256Hex(Buffer.from(JSON.stringify([LINK_PREVIEW_REVISION, draft.title, draft.description]))).slice(0, 12);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Adds Open Graph and Twitter card tags the document doesn't already declare. */
export function addLinkPreview(html: string, preview: LinkPreview): string {
  const scan = scanDocument(html);
  const tags: string[] = [];
  const add = (attribute: "property" | "name", key: string, value: string | null) => {
    if (value !== null && !scan.meta.has(key)) {
      tags.push(`<meta ${attribute}="${key}" content="${escapeAttr(value)}">`);
    }
  };

  const title = clean(preview.title);
  add("property", "og:title", title);
  add("property", "og:description", clean(preview.description));
  add("property", "og:type", "website");
  add("property", "og:site_name", "Postplan");
  add("property", "og:url", preview.pageUrl);
  if (!scan.meta.has("og:image")) {
    add("property", "og:image", preview.imageUrl);
    add("property", "og:image:type", "image/png");
    add("property", "og:image:width", String(OG_WIDTH));
    add("property", "og:image:height", String(OG_HEIGHT));
    add("property", "og:image:alt", title ?? clean(scan.meta.get("og:title")) ?? scan.title ?? UNTITLED);
  }
  add("name", "twitter:card", "summary_large_image");

  if (tags.length === 0) {
    return html;
  }
  return `${html.slice(0, scan.insertAt)}\n${tags.join("\n")}\n${html.slice(scan.insertAt)}`;
}
