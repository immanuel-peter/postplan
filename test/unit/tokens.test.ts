import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_SCOPES,
  generateTokenSecret,
  hashToken,
  hashesEqual,
  parseScopes,
  tokenPrefix,
} from "../../src/lib/tokens.js";

describe("token secrets", () => {
  it("generates pp_ secrets with a stable 11 char prefix", () => {
    const secret = generateTokenSecret();
    assert.match(secret, /^pp_[A-Za-z0-9_-]{32}$/);
    assert.equal(tokenPrefix(secret), secret.slice(0, 11));
    assert.notEqual(generateTokenSecret(), secret);
  });

  it("hashes deterministically per pepper", () => {
    const a = hashToken("pp_x", "pepper-1");
    assert.equal(a, hashToken("pp_x", "pepper-1"));
    assert.notEqual(a, hashToken("pp_x", "pepper-2"));
    assert.notEqual(a, hashToken("pp_y", "pepper-1"));
  });

  it("compares hashes safely, including different lengths", () => {
    assert.equal(hashesEqual("abc", "abc"), true);
    assert.equal(hashesEqual("abc", "abd"), false);
    assert.equal(hashesEqual("abc", "abcd"), false);
  });
});

describe("parseScopes", () => {
  it("dedupes known scopes", () => {
    assert.deepEqual(parseScopes(["drafts:read", "drafts:read", "tokens:manage"]), [
      "drafts:read",
      "tokens:manage",
    ]);
    assert.deepEqual(parseScopes([...ALL_SCOPES]), [...ALL_SCOPES]);
  });

  it("rejects bad input", () => {
    assert.throws(() => parseScopes("drafts:read"), /array/);
    assert.throws(() => parseScopes([]), /empty/);
    assert.throws(() => parseScopes(["drafts:admin"]), /unknown scope/);
    assert.throws(() => parseScopes([1]), /unknown scope/);
  });
});
