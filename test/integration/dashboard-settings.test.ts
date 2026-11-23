import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adminSetup } from "../../src/db/schema.js";
import { hashToken } from "../../src/lib/tokens.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import { apiHost, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// See dashboard-guard.test.ts: a non-.localhost base domain outside development is production.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";
const THEME_COOKIE = "__Host-postplan_theme";

describe("dashboard settings and appearance", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
    await t.db.insert(adminSetup).values({ id: "singleton", closedAt: new Date() });
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

  function get(url: string, cookie: string) {
    return t.app.inject({ method: "GET", url, headers: { ...apiHost(), cookie } });
  }

  function postTheme(cookie: string, fields: Record<string, string>, accept?: string) {
    return t.app.inject({
      method: "POST",
      url: "/settings/appearance",
      headers: {
        ...apiHost(),
        cookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        ...(accept ? { accept } : {}),
      },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  it("sends /settings and the old pages to the Settings tabs", async () => {
    const { cookie } = await session();
    const settings = await get("/settings", cookie);
    assert.equal(settings.statusCode, 302);
    assert.equal(settings.headers.location, "/settings/keys");

    const keys = await get("/keys", cookie);
    assert.equal(keys.statusCode, 301);
    assert.equal(keys.headers.location, "/settings/keys");

    const security = await get("/security", cookie);
    assert.equal(security.statusCode, 301);
    assert.equal(security.headers.location, "/settings/security");
  });

  it("replaces the API keys and Security nav links with Settings", async () => {
    const { cookie } = await session();
    const drafts = await get("/", cookie);
    assert.match(drafts.body, /<a href="\/settings" class="">Settings<\/a>/);
    assert.doesNotMatch(drafts.body, /href="\/keys"|href="\/security"/);

    const appearance = await get("/settings/appearance", cookie);
    assert.match(appearance.body, /<a href="\/settings" class="active">Settings<\/a>/);
    assert.match(appearance.body, /<nav class="settings-nav" aria-label="Settings">/);
    assert.match(appearance.body, /<a href="\/settings\/appearance" aria-current="page">/);
    assert.doesNotMatch(appearance.body, /<a href="\/settings\/keys" aria-current="page">/);
  });

  it("follows the OS until a theme is chosen", async () => {
    const { cookie } = await session();
    const res = await get("/settings/appearance", cookie);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<html lang="en">/);
    assert.match(res.body, /<meta name="theme-color" content="#f6f5f2" media="\(prefers-color-scheme: light\)" \/>/);
    assert.match(res.body, /<meta name="theme-color" content="#161513" media="\(prefers-color-scheme: dark\)" \/>/);
    assert.match(res.body, /<input type="radio" name="theme" value="system" checked \/>/);
    assert.match(res.body, /<input type="radio" name="theme" value="dark" \/>/);
  });

  it("saves the theme in a cookie and renders it on every page", async () => {
    const { cookie, csrf } = await session();
    const saved = await postTheme(cookie, { _csrf: csrf, theme: "dark" });
    assert.equal(saved.statusCode, 302);
    assert.equal(saved.headers.location, "/settings/appearance");
    assert.equal(
      saved.headers["set-cookie"],
      `${THEME_COOKIE}=dark; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure`,
    );

    const withTheme = `${cookie}; ${THEME_COOKIE}=dark`;
    const appearance = await get("/settings/appearance", withTheme);
    assert.match(appearance.body, /<html lang="en" data-theme="dark">/);
    assert.match(appearance.body, /<meta name="theme-color" content="#161513" \/>/);
    assert.match(appearance.body, /<input type="radio" name="theme" value="dark" checked \/>/);

    const drafts = await get("/", withTheme);
    assert.match(drafts.body, /<html lang="en" data-theme="dark">/);

    const unlock = await t.app.inject({ method: "GET", url: "/unlock", headers: { ...apiHost(), cookie: `${THEME_COOKIE}=light` } });
    assert.equal(unlock.statusCode, 200);
    assert.match(unlock.body, /<html lang="en" data-theme="light">/);
  });

  it("answers the live switch with 204 and rejects unknown themes", async () => {
    const { cookie, csrf } = await session();
    const live = await postTheme(cookie, { _csrf: csrf, theme: "light" }, "application/json");
    assert.equal(live.statusCode, 204);
    assert.match(String(live.headers["set-cookie"]), new RegExp(`^${THEME_COOKIE}=light;`));

    const bad = await postTheme(cookie, { _csrf: csrf, theme: "sepia" });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.headers["set-cookie"], undefined);

    const forged = await postTheme(cookie, { _csrf: "nope", theme: "dark" });
    assert.equal(forged.statusCode, 403);

    const unknown = await get("/settings/appearance", `${cookie}; ${THEME_COOKIE}=sepia`);
    assert.match(unknown.body, /<html lang="en">/);
  });
});
