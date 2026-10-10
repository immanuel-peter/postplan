import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adminSetup } from "../../src/db/schema.js";
import { hashToken } from "../../src/lib/tokens.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import { apiHost, multipart, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// relyingParty() treats a non-.localhost base domain in a non-development env as production,
// so the session cookie uses the __Host- prefix and the only allowed origin is https://apex.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";

describe("dashboard guard", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t?.close();
  });

  async function session() {
    const { token } = await createSession({ db: t.db, pepper: t.config.tokenPepper, userAgent: "test" });
    const record = await authenticateSession({ db: t.db, pepper: t.config.tokenPepper, token });
    assert.ok(record);
    return {
      cookie: `${COOKIE}=${token}`,
      csrf: hashToken(`csrf:${record.id}`, t.config.tokenPepper),
    };
  }

  it("sends a fresh install to /setup, then to /unlock once setup is closed", async () => {
    const fresh = await t.app.inject({ method: "GET", url: "/", headers: apiHost() });
    assert.equal(fresh.statusCode, 302);
    assert.equal(fresh.headers.location, "/setup");
    assert.equal(fresh.headers["cache-control"], "no-store");

    // The row a completed passkey enrollment leaves behind.
    await t.db.insert(adminSetup).values({ id: "singleton", closedAt: new Date() });

    const locked = await t.app.inject({ method: "GET", url: "/keys?x=1", headers: apiHost() });
    assert.equal(locked.statusCode, 302);
    assert.equal(locked.headers.location, `/unlock?next=${encodeURIComponent("/keys?x=1")}`);
  });

  it("refuses writes without a session", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/drafts/whatever/delete",
      headers: { ...apiHost(), origin: ORIGIN },
      payload: { _csrf: "x" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, "locked");
  });

  it("ignores forged or unknown session cookies", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/keys",
      headers: { ...apiHost(), cookie: `${COOKIE}=forged` },
    });
    assert.equal(res.statusCode, 302);
  });

  it("redirects loopback reads to the canonical origin", async () => {
    const res = await t.app.inject({ method: "GET", url: "/keys", headers: { host: "localhost:3000" } });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `${ORIGIN}/keys`);
  });

  it("lets a session read the dashboard", async () => {
    const { cookie } = await session();
    const res = await t.app.inject({ method: "GET", url: "/", headers: { ...apiHost(), cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers["content-type"]), /text\/html/);
  });

  it("requires a same-origin Origin or Referer on writes", async () => {
    const { cookie, csrf } = await session();
    const base = { method: "POST" as const, url: "/drafts/missing/delete", payload: { _csrf: csrf } };

    const noOrigin = await t.app.inject({ ...base, headers: { ...apiHost(), cookie } });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal(noOrigin.body, "bad origin");

    const crossOrigin = await t.app.inject({ ...base, headers: { ...apiHost(), cookie, origin: "https://evil.test" } });
    assert.equal(crossOrigin.body, "bad origin");

    const viaReferer = await t.app.inject({
      ...base,
      headers: { ...apiHost(), cookie, referer: `${ORIGIN}/drafts/missing` },
    });
    assert.equal(viaReferer.statusCode, 404, "passes the guard and reaches the handler");
  });

  it("requires a matching CSRF token on form writes", async () => {
    const { cookie, csrf } = await session();
    const headers = { ...apiHost(), cookie, origin: ORIGIN };

    const missing = await t.app.inject({ method: "POST", url: "/drafts/missing/delete", headers, payload: {} });
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.body, "bad csrf");

    const wrong = await t.app.inject({
      method: "POST",
      url: "/drafts/missing/delete",
      headers,
      payload: { _csrf: "a".repeat(csrf.length) },
    });
    assert.equal(wrong.body, "bad csrf");

    const other = await session();
    const crossSession = await t.app.inject({
      method: "POST",
      url: "/drafts/missing/delete",
      headers,
      payload: { _csrf: other.csrf },
    });
    assert.equal(crossSession.body, "bad csrf", "a CSRF token is bound to its own session");

    const ok = await t.app.inject({
      method: "POST",
      url: "/drafts/missing/delete",
      headers,
      payload: { _csrf: csrf },
    });
    assert.equal(ok.statusCode, 404);
  });

  it("does not let a multipart content type skip CSRF on non-multipart routes", async () => {
    const { cookie } = await session();
    const form = multipart([{ name: "title", value: "pwned" }]);
    const res = await t.app.inject({
      method: "POST",
      url: "/drafts/missing/delete",
      headers: { ...apiHost(), cookie, origin: ORIGIN, ...form.headers },
      payload: form.payload,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body, "bad csrf");
  });
});
