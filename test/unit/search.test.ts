import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchConditions, searchWords } from "../../src/lib/search.js";
import { drafts } from "../../src/db/schema.js";

describe("search helper", () => {
  it("splits on whitespace like the dashboard filter", () => {
    assert.deepEqual(searchWords(undefined), []);
    assert.deepEqual(searchWords("  "), []);
    assert.deepEqual(searchWords("  zephyr   SHIP "), ["zephyr", "ship"]);
  });

  it("builds one OR-group per word", () => {
    assert.deepEqual(searchConditions([drafts.title, drafts.description, drafts.repositoryName], undefined), []);
    assert.deepEqual(searchConditions([drafts.title], "one two three").length, 3);
  });
});
