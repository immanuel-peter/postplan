import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Hex } from "../../src/lib/hash.js";
import { MAX_HTML_BYTES, isHtmlValidationError, validateHtml } from "../../src/lib/html.js";

function expectError(input: Buffer, detail: RegExp) {
  const result = validateHtml(input);
  assert.ok(isHtmlValidationError(result), "expected a validation error");
  assert.equal(result.status, 400);
  assert.match(result.detail, detail);
}

describe("validateHtml", () => {
  it("accepts a full document and hashes it", () => {
    const bytes = Buffer.from("<!doctype html><html><head></head><body><p>hi</p></body></html>");
    const result = validateHtml(bytes);
    assert.ok(!isHtmlValidationError(result));
    assert.equal(result.byteSize, bytes.byteLength);
    assert.equal(result.sha256, sha256Hex(bytes));
  });

  it("accepts a fragment because parse5 synthesizes html and body", () => {
    // Worth pinning: the "complete document" check is lenient by design of the HTML parser.
    assert.ok(!isHtmlValidationError(validateHtml(Buffer.from("<p>just a fragment</p>"))));
  });

  it("rejects empty input", () => {
    expectError(Buffer.alloc(0), /empty/);
  });

  it("rejects input over the size cap", () => {
    expectError(Buffer.alloc(MAX_HTML_BYTES + 1, "a"), /exceeds/);
  });

  it("rejects invalid UTF-8", () => {
    expectError(Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]), /UTF-8/);
  });

  it("rejects NUL bytes", () => {
    expectError(Buffer.from("<p>a\u0000b</p>"), /NUL/);
  });
});
