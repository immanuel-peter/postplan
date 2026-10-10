import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assetOrigin,
  classifyHost,
  dashboardHostConstraint,
  hostnameFromHeader,
  isDashboardHostKind,
  localDraftUrl,
  publicAssetUrl,
  publicDraftUrl,
} from "../../src/lib/host.js";

const BASE = "postplan.domain";

describe("hostnameFromHeader", () => {
  it("strips ports and lowercases", () => {
    assert.equal(hostnameFromHeader("Foo.Postplan.Domain:3000"), "foo.postplan.domain");
    assert.equal(hostnameFromHeader("postplan.domain"), "postplan.domain");
  });

  it("handles bracketed IPv6", () => {
    assert.equal(hostnameFromHeader("[::1]:3000"), "::1");
    assert.equal(hostnameFromHeader("[::1]"), "::1");
  });

  it("returns empty for a missing header", () => {
    assert.equal(hostnameFromHeader(undefined), "");
  });
});

describe("classifyHost", () => {
  it("routes the apex, assets, and draft subdomains", () => {
    assert.deepEqual(classifyHost(BASE, BASE), { kind: "apex" });
    assert.deepEqual(classifyHost(`assets.${BASE}`, BASE), { kind: "assets" });
    assert.deepEqual(classifyHost(`abc123.${BASE}:443`, BASE), { kind: "draft", slug: "abc123" });
    assert.deepEqual(classifyHost(`ABC123.${BASE.toUpperCase()}`, BASE), { kind: "draft", slug: "abc123" });
  });

  it("treats loopback hosts as local", () => {
    for (const host of ["localhost:3000", "127.0.0.1", "[::1]:3000"]) {
      assert.deepEqual(classifyHost(host, BASE), { kind: "local" }, host);
    }
  });

  it("rejects nested subdomains, foreign hosts, and suffix tricks", () => {
    for (const host of [
      `a.b.${BASE}`,
      "example.com",
      `evil${BASE}`,
      `${BASE}.evil.com`,
      `.${BASE}`,
      "",
      undefined,
    ]) {
      assert.deepEqual(classifyHost(host, BASE), { kind: "reject" }, String(host));
    }
  });
});

describe("url builders", () => {
  it("builds public and pinned draft urls", () => {
    assert.equal(publicDraftUrl(BASE, "abc"), "https://abc.postplan.domain/");
    assert.equal(publicDraftUrl(BASE, "abc", 3), "https://abc.postplan.domain/v/3");
    assert.equal(localDraftUrl("abc", 3000, 2), "http://abc.postplan.localhost:3000/v/2");
  });

  it("keeps the asset extension only when present", () => {
    assert.equal(publicAssetUrl(BASE, "01ABC", "png"), "https://assets.postplan.domain/01ABC.png");
    assert.equal(publicAssetUrl(BASE, "01ABC"), "https://assets.postplan.domain/01ABC");
  });

  it("uses the local asset origin in development or on .localhost", () => {
    assert.equal(
      assetOrigin({ baseDomain: BASE, port: 3000, nodeEnv: "production" }),
      "https://assets.postplan.domain",
    );
    assert.equal(
      assetOrigin({ baseDomain: BASE, port: 3000, nodeEnv: "development" }),
      "http://assets.postplan.localhost:3000",
    );
    assert.equal(
      assetOrigin({ baseDomain: "postplan.localhost", port: 8080, nodeEnv: "production" }),
      "http://assets.postplan.localhost:8080",
    );
  });
});

describe("dashboard host", () => {
  it("matches apex and loopback only", () => {
    const re = dashboardHostConstraint(BASE);
    assert.ok(re.test("postplan.domain"));
    assert.ok(re.test("postplan.domain:3000"));
    assert.ok(re.test("localhost:3000"));
    assert.ok(re.test("[::1]:3000"));
    assert.ok(!re.test("abc.postplan.domain"));
    assert.ok(!re.test("postplanXdomain"), "dots in the base domain must be escaped");
  });

  it("only apex and local are dashboard kinds", () => {
    assert.equal(isDashboardHostKind("apex"), true);
    assert.equal(isDashboardHostKind("local"), true);
    assert.equal(isDashboardHostKind("draft"), false);
    assert.equal(isDashboardHostKind("assets"), false);
    assert.equal(isDashboardHostKind("reject"), false);
  });
});
