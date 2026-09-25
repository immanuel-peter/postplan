import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  challengeCookieName,
  createRateLimiter,
  readCookie,
  relyingParty,
  serializeCookie,
  sessionCookieName,
} from "../../src/lib/admin-auth.js";
import { testConfig } from "../helpers/app.js";

describe("relyingParty", () => {
  it("is https and secure in production", () => {
    const rp = relyingParty(testConfig({ baseDomain: "postplan.domain", nodeEnv: "production" }));
    assert.deepEqual(rp, {
      id: "postplan.domain",
      name: "PostPlan",
      origin: "https://postplan.domain",
      secure: true,
    });
    assert.equal(sessionCookieName(rp), "__Host-postplan_session");
    assert.equal(challengeCookieName(rp), "__Host-postplan_challenge");
  });

  it("is http with a port and not secure locally", () => {
    const rp = relyingParty(testConfig({ baseDomain: "postplan.localhost", port: 3000, nodeEnv: "production" }));
    assert.equal(rp.origin, "http://postplan.localhost:3000");
    assert.equal(rp.secure, false);
    assert.equal(sessionCookieName(rp), "postplan_session");
  });
});

describe("cookies", () => {
  it("serializes with hardening attributes", () => {
    assert.equal(
      serializeCookie("s", "v", { maxAge: 60, secure: true }),
      "s=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure",
    );
    assert.ok(!serializeCookie("s", "v", { maxAge: 0, secure: false }).includes("Secure"));
  });

  it("reads a named cookie and ignores lookalikes", () => {
    const header = "other=1; xpostplan_session=nope; postplan_session=abc=def; junk";
    assert.equal(readCookie(header, "postplan_session"), "abc=def");
    assert.equal(readCookie(header, "missing"), null);
    assert.equal(readCookie(undefined, "postplan_session"), null);
  });
});

describe("createRateLimiter", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("allows up to the limit per key within the window, then recovers", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    assert.equal(limiter.check("a"), true);
    assert.equal(limiter.check("a"), true);
    assert.equal(limiter.check("a"), false);
    assert.equal(limiter.check("b"), true, "keys are independent");

    mock.timers.tick(999);
    assert.equal(limiter.check("a"), false);
    mock.timers.tick(1);
    assert.equal(limiter.check("a"), true);
  });
});
