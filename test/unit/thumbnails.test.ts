import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import sharp from "sharp";
import { makeThumbnail, THUMB_HEIGHT, THUMB_WIDTH } from "../../src/lib/thumbnails.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function solidPng(width: number, height: number, color: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

describe("makeThumbnail", () => {
  it("shrinks an image to a small WebP and reports its dominant colour", async () => {
    const thumb = await makeThumbnail(await solidPng(2000, 1200, "#d03030"), "image/png");
    assert.ok(thumb);
    const meta = await sharp(thumb.bytes).metadata();
    assert.equal(meta.format, "webp");
    assert.equal(meta.width, THUMB_WIDTH);
    assert.equal(meta.height, THUMB_HEIGHT);
    assert.ok(thumb.bytes.byteLength < 2048, `${thumb.bytes.byteLength} bytes`);
    assert.match(thumb.color, /^#[0-9a-f]{6}$/);
    assert.ok(Number.parseInt(thumb.color.slice(1, 3), 16) > 0xb0, `${thumb.color} is mostly red`);
  });

  it("returns null for files it cannot preview", async () => {
    assert.equal(await makeThumbnail(Buffer.from("\x89PNG fake"), "image/png"), null);
    assert.equal(await makeThumbnail(Buffer.from("hello"), "text/plain"), null);
    assert.equal(await makeThumbnail(Buffer.from("<svg/>"), "image/svg+xml"), null);
    assert.equal(await makeThumbnail(Buffer.from("not a video"), "video/mp4"), null);
  });

  it("takes a poster frame from a video", { skip: hasFfmpeg ? false : "ffmpeg is not installed" }, async () => {
    const video = execFileSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "-"],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const thumb = await makeThumbnail(video, "video/mp4");
    assert.ok(thumb);
    assert.equal((await sharp(thumb.bytes).metadata()).format, "webp");
    assert.ok(Number.parseInt(thumb.color.slice(5, 7), 16) > 0xb0, `${thumb.color} is mostly blue`);
  });
});
