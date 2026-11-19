import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { addLinkPreview, previewFingerprint, previewText } from "../../src/lib/link-preview.js";

type Element = DefaultTreeAdapterMap["element"];

const preview = {
  title: "Cache hit rates",
  description: "Per-workload",
  pageUrl: "https://abc.postplan.link/",
  imageUrl: "https://abc.postplan.link/og.png",
};

function headMetaKeys(html: string): string[] {
  const document = parse(html);
  const root = document.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "html");
  const head = root?.childNodes.find((n): n is Element => "tagName" in n && n.tagName === "head");
  return (head?.childNodes ?? [])
    .filter((n): n is Element => "tagName" in n && n.tagName === "meta")
    .map((m) => m.attrs.find((a) => a.name === "property" || a.name === "name")?.value ?? "")
    .filter((key) => key !== "");
}

describe("addLinkPreview", () => {
  it("inserts the tags right after <head> and leaves every other byte alone", () => {
    const html = '<!doctype html>\r\n<html lang="é">\r\n<head><meta charset="utf-8"><title>t</title></head><body>ü</body></html>';
    const out = addLinkPreview(html, preview);
    const at = html.indexOf("<head>") + "<head>".length;
    assert.ok(out.startsWith(html.slice(0, at)));
    assert.ok(out.endsWith(html.slice(at)));
    assert.deepEqual(headMetaKeys(out), [
      "og:title",
      "og:description",
      "og:type",
      "og:site_name",
      "og:url",
      "og:image",
      "og:image:type",
      "og:image:width",
      "og:image:height",
      "og:image:alt",
      "twitter:card",
    ]);
  });

  it("keeps the tags in <head> when the document has no head, html, or doctype", () => {
    for (const html of [
      "<!doctype html><html><body><p>x</p></body></html>",
      "<!doctype html><p>x</p>",
      "<p>x</p>",
    ]) {
      const out = addLinkPreview(html, preview);
      assert.ok(headMetaKeys(out).includes("og:image"), html);
      if (html.startsWith("<!doctype")) {
        assert.ok(out.startsWith("<!doctype html>"), "never ahead of the doctype");
      }
    }
  });

  it("does not override tags the document already declares", () => {
    const html =
      '<html><head><meta property="og:image" content="mine.png"><meta name="twitter:card" content="summary">' +
      '<meta property="og:title" content="Own title"></head><body></body></html>';
    const keys = headMetaKeys(addLinkPreview(html, preview));
    assert.equal(keys.filter((k) => k === "og:image").length, 1);
    assert.equal(keys.filter((k) => k === "og:title").length, 1);
    assert.equal(keys.filter((k) => k === "twitter:card").length, 1);
    assert.ok(!keys.includes("og:image:width"), "image dimensions belong to the document's own image");
    assert.ok(keys.includes("og:description"));
  });

  it("escapes values and falls back to the document title for alt text", () => {
    const out = addLinkPreview("<html><head><title>Doc &amp; title</title></head><body></body></html>", {
      ...preview,
      title: null,
      description: `say "hi" <now>`,
    });
    assert.ok(!out.includes('property="og:title"'), "crawlers already read <title>");
    assert.ok(out.includes('<meta property="og:description" content="say &quot;hi&quot; &lt;now&gt;">'));
    assert.ok(out.includes('<meta property="og:image:alt" content="Doc &amp; title">'));
  });

  it("returns the document unchanged when every tag is already there", () => {
    const keys = ["og:title", "og:description", "og:type", "og:site_name", "og:url", "og:image"];
    const head = keys.map((k) => `<meta property="${k}" content="x">`).join("") + '<meta name="twitter:card" content="x">';
    const html = `<html><head>${head}</head><body></body></html>`;
    assert.equal(addLinkPreview(html, preview), html);
  });
});

describe("previewText", () => {
  it("prefers the Draft's own title and description", () => {
    const html = '<html><head><title>Doc</title><meta name="description" content="Doc desc"></head></html>';
    assert.deepEqual(previewText({ title: " Mine ", description: "Mine too" }, html), { title: "Mine", description: "Mine too" });
  });

  it("falls back to og tags, then <title> and meta description, then a placeholder", () => {
    const og = '<html><head><meta property="og:title" content="OG"><title>Doc</title><meta name="description" content="Desc"></head></html>';
    assert.deepEqual(previewText({ title: null, description: "" }, og), { title: "OG", description: "Desc" });
    const plain = "<html><head><title>  Doc\n title </title></head></html>";
    assert.deepEqual(previewText({ title: "", description: null }, plain), { title: "Doc title", description: null });
    assert.deepEqual(previewText({ title: null, description: null }, "<p>x</p>"), { title: "Untitled draft", description: null });
  });

  it("ignores SVG titles", () => {
    const html = "<html><body><svg><title>icon</title></svg></body></html>";
    assert.equal(previewText({ title: null, description: null }, html).title, "Untitled draft");
  });
});

describe("previewFingerprint", () => {
  it("changes with the title or description", () => {
    const base = previewFingerprint({ title: "a", description: null });
    assert.match(base, /^[0-9a-f]{12}$/);
    assert.equal(previewFingerprint({ title: "a", description: null }), base);
    assert.notEqual(previewFingerprint({ title: "b", description: null }), base);
    assert.notEqual(previewFingerprint({ title: "a", description: "d" }), base);
  });
});
