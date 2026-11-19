import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { OG_HEIGHT, OG_WIDTH, cardLines, renderOgCard } from "../../src/lib/og-card.js";

describe("renderOgCard", () => {
  it("renders a small 1200x630 PNG", async () => {
    const png = await renderOgCard({
      title: "Prefix cache hit rates across twelve production workloads",
      description: "Per-workload breakdowns from the November benchmark run.",
      slug: "q7m2xk9v4t1bz8n3w6c0rp5hdy",
      domain: "postplan.link",
      version: 3,
    });
    const meta = await sharp(png).metadata();
    assert.equal(meta.format, "png");
    assert.equal(meta.width, OG_WIDTH);
    assert.equal(meta.height, OG_HEIGHT);
    assert.ok(png.byteLength < 100_000, `${png.byteLength} bytes`);
  });
});

describe("cardLines", () => {
  it("keeps a short title on one line and skips a missing description", () => {
    assert.deepEqual(cardLines({ title: "Hello", description: null }), { title: ["Hello"], description: [] });
  });

  it("clamps the title to three lines and the description to two, ending in an ellipsis", () => {
    const lines = cardLines({
      title: "word ".repeat(80),
      description: "detail ".repeat(80),
    });
    assert.equal(lines.title.length, 3);
    assert.equal(lines.description.length, 2);
    assert.ok(lines.title[2]?.endsWith("word…"), lines.title[2]);
    assert.ok(lines.description[1]?.endsWith("detail…"), lines.description[1]);
  });

  it("breaks a single word too wide for the card", () => {
    const lines = cardLines({ title: "x".repeat(200), description: null });
    assert.equal(lines.title.length, 3);
    assert.ok(lines.title.every((line) => line.length > 0));
    assert.ok(lines.title[2]?.endsWith("…"));
  });

  it("drops characters the fonts can't draw", () => {
    assert.deepEqual(cardLines({ title: "Launch 🚀 day", description: "改 ok" }).title, ["Launch day"]);
    assert.deepEqual(cardLines({ title: "改", description: "改" }), { title: ["Untitled draft"], description: [] });
  });
});
