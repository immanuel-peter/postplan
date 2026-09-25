import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SECURITY_POLICY_VERSION, currentEtag, draftCsp, versionEtag } from "../../src/lib/csp.js";
import { assetObjectKey, versionObjectKey } from "../../src/lib/s3.js";
import { generateSlug, isReservedSlug } from "../../src/lib/slug.js";
import { formatStamp, shortCommit } from "../../src/lib/time.js";
import {
  contentTypeForUpload,
  extensionOf,
  normalizeAssetDescription,
  parseAssetPath,
} from "../../src/services/assets.js";

describe("draftCsp", () => {
  it("is pinned; loosening it should be a deliberate change", () => {
    assert.equal(SECURITY_POLICY_VERSION, 2);
    assert.equal(
      draftCsp("https://assets.postplan.domain"),
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src 'self' data: blob: https://assets.postplan.domain; " +
        "media-src 'self' data: blob: https://assets.postplan.domain; connect-src *; frame-ancestors 'none'",
    );
  });

  it("builds quoted etags", () => {
    assert.equal(currentEtag("d1", 3), '"d1-3"');
    assert.equal(versionEtag("abc"), '"abc"');
  });
});

describe("slugs", () => {
  it("are 26 lowercase base36 chars and unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const slug = generateSlug();
      assert.match(slug, /^[a-z0-9]{26}$/);
      seen.add(slug);
    }
    assert.equal(seen.size, 200);
  });

  it("reserves assets case-insensitively", () => {
    assert.equal(isReservedSlug("assets"), true);
    assert.equal(isReservedSlug("ASSETS"), true);
    assert.equal(isReservedSlug("assetz"), false);
  });
});

describe("object keys", () => {
  it("builds version keys", () => {
    assert.equal(versionObjectKey("d1", 2), "drafts/d1/versions/2.html");
  });

  it("sanitizes asset filenames", () => {
    assert.equal(assetObjectKey("a1", "photo.png"), "assets/a1/photo.png");
    assert.equal(assetObjectKey("a1", "../../etc/passwd"), "assets/a1/passwd");
    assert.equal(assetObjectKey("a1", "C:\\Users\\me\\my pic!.jpg"), "assets/a1/my_pic_.jpg");
    assert.equal(assetObjectKey("a1", "...hidden"), "assets/a1/hidden");
    assert.equal(assetObjectKey("a1", null), "assets/a1/file");
    assert.equal(assetObjectKey("a1", `${"x".repeat(300)}.png`).length, "assets/a1/".length + 180);
  });
});

describe("asset helpers", () => {
  it("extracts sane extensions only", () => {
    assert.equal(extensionOf("a.PNG"), "png");
    assert.equal(extensionOf(".bashrc"), undefined);
    assert.equal(extensionOf("trailing."), undefined);
    assert.equal(extensionOf("weird.ex-t"), undefined);
    assert.equal(extensionOf(null), undefined);
  });

  it("prefers a valid mimetype, then the extension, then octet-stream", () => {
    assert.equal(contentTypeForUpload("image/png; charset=binary", "x.bin"), "image/png");
    assert.equal(contentTypeForUpload("garbage", "x.svg"), "image/svg+xml");
    assert.equal(contentTypeForUpload(undefined, "x.unknown"), "application/octet-stream");
  });

  it("parses the id out of an asset path", () => {
    assert.equal(parseAssetPath("01ABC.png"), "01ABC");
    assert.equal(parseAssetPath("/01ABC"), "01ABC");
    assert.equal(parseAssetPath("01ABC/extra"), "01ABC");
    assert.equal(parseAssetPath(""), "");
  });

  it("normalizes descriptions", () => {
    assert.equal(normalizeAssetDescription(undefined), undefined);
    assert.equal(normalizeAssetDescription(null), null);
    assert.equal(normalizeAssetDescription("   "), null);
    assert.equal(normalizeAssetDescription("  alt text "), "alt text");
    assert.equal(typeof normalizeAssetDescription(42), "object");
    assert.equal(typeof normalizeAssetDescription("x".repeat(2001)), "object");
  });
});

describe("time helpers", () => {
  it("formats UTC stamps and tolerates junk", () => {
    assert.equal(formatStamp(new Date("2026-01-02T03:04:05Z")), "2026-01-02 03:04");
    assert.equal(formatStamp("2026-01-02T03:04:05Z"), "2026-01-02 03:04");
    assert.equal(formatStamp("nope"), "—");
    assert.equal(formatStamp(null), "—");
  });

  it("shortens commits", () => {
    assert.equal(shortCommit("0123456789abcdef"), "0123456");
    assert.equal(shortCommit(undefined), "");
  });
});
