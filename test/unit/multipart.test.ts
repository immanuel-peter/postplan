import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optionalField, parseExpectedVersion } from "../../src/lib/multipart.js";

describe("parseExpectedVersion", () => {
  it("parses quoted and bare If-Match values", () => {
    assert.equal(parseExpectedVersion({ header: '"3"' }), 3);
    assert.equal(parseExpectedVersion({ header: "3" }), 3);
    assert.equal(parseExpectedVersion({ header: '  "12"  ' }), 12);
  });

  it("falls back to the form field when the header is absent or blank", () => {
    assert.equal(parseExpectedVersion({ field: "4" }), 4);
    assert.equal(parseExpectedVersion({ header: "  ", field: "5" }), 5);
  });

  it("prefers the header over the field", () => {
    assert.equal(parseExpectedVersion({ header: '"2"', field: "9" }), 2);
  });

  it("rejects missing, zero, negative, and non-numeric values", () => {
    assert.equal(parseExpectedVersion({}), null);
    assert.equal(parseExpectedVersion({ header: '"0"' }), null);
    assert.equal(parseExpectedVersion({ header: "-1" }), null);
    assert.equal(parseExpectedVersion({ header: "abc" }), null);
    assert.equal(parseExpectedVersion({ header: "*" }), null);
  });
});

describe("optionalField", () => {
  it("distinguishes absent, blank, and present", () => {
    const fields = { title: "  Hello ", empty: "   " };
    assert.equal(optionalField(fields, "missing"), undefined);
    assert.equal(optionalField(fields, "empty"), null);
    assert.equal(optionalField(fields, "title"), "Hello");
  });
});
