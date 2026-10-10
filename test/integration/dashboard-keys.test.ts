import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adminSetup } from "../../src/db/schema.js";
import { hashToken } from "../../src/lib/tokens.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import { apiHost, auth, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// See dashboard-guard.test.ts: a non-.localhost base domain outside development is production.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";

describe("dashboard API keys page", { skip: skipWithoutDb }, () => {
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

  async function getKeys(cookie: string) {
    const res = await t.app.inject({ method: "GET", url: "/keys", headers: { ...apiHost(), cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return res.body;
  }

  function postForm(url: string, cookie: string, fields: Record<string, string>) {
    return t.app.inject({
      method: "POST",
      url,
      headers: {
        ...apiHost(),
        cookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams(fields).toString(),
    });
  }

  function revokeAction(html: string, name: string): string {
    const action = new RegExp(`action="(/keys/[^"/]+/revoke)" data-confirm-name="${name}"`).exec(html)?.[1];
    assert.ok(action, `no revoke form for ${name}`);
    return action;
  }

  it("renders the Workbench layout without the old copy", async () => {
    const { cookie } = await session();
    const html = await getKeys(cookie);

    assert.match(html, /<h1>API keys<\/h1>/);
    assert.doesNotMatch(html, /class="lede"/);
    assert.doesNotMatch(html, /Authorization: Bearer/);
    assert.match(html, /<h2 id="new-key-title">New key<\/h2>/);
    assert.match(html, /placeholder="e\.g\. CI script"/);
    assert.doesNotMatch(html, /API · UTC stamp/);
    assert.match(html, /Keys are shown once\./);
    assert.doesNotMatch(html, /Each visit can mint a fresh key/);
    assert.match(html, /<h2 id="keys-title">Keys<\/h2>\s*<span class="panel-count">1<\/span>/);
    assert.doesNotMatch(html, /Active keys/);
    assert.match(html, /<table class="data-table">/);
    assert.match(html, /<span class="sr-only">Actions<\/span>/);
  });

  it("stamps dates for the viewer's timezone and says Never for unused keys", async () => {
    const { cookie } = await session();
    const html = await getKeys(cookie);

    assert.match(
      html,
      /<td class="col-time hide-xs">\s*<time datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" data-local>\d{4}-\d\d-\d\d \d\d:\d\d<\/time>/,
    );
    // The bootstrap token has not been used yet.
    assert.match(html, /<td class="col-time hide-xs">\s*Never\s*<\/td>/);
    assert.match(html, /<div class="row-meta">\s*Never used\s*<\/div>/);

    await t.app.inject({ method: "GET", url: "/api/v1/drafts", headers: { ...apiHost(), ...auth } });
    const used = await getKeys(cookie);
    assert.doesNotMatch(used, /Never/);
    // Phones drop the side columns and show last use under the name instead.
    assert.match(
      used,
      /<div class="row-meta">\s*Last used <time datetime="\d{4}-\d\d-\d\dT[^"]+Z" data-local>\d{4}-\d\d-\d\d \d\d:\d\d<\/time>\s*<\/div>/,
    );
    assert.equal(used.match(/<time datetime="[^"]+" data-local>/g)?.length, 3);
  });

  it("puts a confirm step in front of every revoke", async () => {
    const { cookie } = await session();
    const html = await getKeys(cookie);

    assert.match(
      html,
      /<form method="post" action="\/keys\/[^"/]+\/revoke" data-confirm-name="bootstrap" data-confirm-prefix="pp_[^"]+">/,
    );
    assert.match(
      html,
      /<button class="btn btn-sm btn-danger-soft" type="submit" aria-label="Revoke bootstrap">Revoke<\/button>/,
    );
    assert.match(html, /<dialog class="confirm" id="revoke-dialog" aria-labelledby="revoke-title">/);
    assert.match(html, /<h2 id="revoke-title">Revoke “<span data-name><\/span>”\?<\/h2>/);
    assert.match(html, /Anything using <code data-prefix><\/code> stops working right away\. This can’t be undone\./);
    assert.match(html, /<button class="btn btn-secondary" type="button" data-cancel autofocus>Cancel<\/button>/);
    assert.match(html, /<button class="btn btn-danger" type="button" data-confirm>Revoke key<\/button>/);
    assert.equal(html.match(/<dialog /g)?.length, 1, "one shared dialog, not one per row");
  });

  it("generates a key, shows it once inside the New key panel, and revokes it by POST", async () => {
    const { cookie, csrf } = await session();

    const created = await postForm("/keys", cookie, { _csrf: csrf, name: "CI script" });
    assert.equal(created.statusCode, 200, created.body);
    assert.match(
      created.body,
      /Keys are shown once\.<\/p>\s*<div class="secret-panel">[\s\S]*<code id="new-secret">pp_[^<]+<\/code>[\s\S]*<\/div>\s*<\/section>\s*<section class="panel" aria-labelledby="keys-title">/,
    );
    assert.match(created.body, /<span class="panel-count">2<\/span>/);
    assert.match(created.body, /<div class="cell-title">CI script<\/div>\s*<div class="cell-sub mono">pp_[^<]+…<\/div>/);

    const action = revokeAction(await getKeys(cookie), "CI script");
    const revoked = await postForm(action, cookie, { _csrf: csrf });
    assert.equal(revoked.statusCode, 302);
    assert.equal(revoked.headers.location, "/keys");

    const after = await getKeys(cookie);
    assert.doesNotMatch(after, /CI script<\/div>/);
    assert.match(after, /<span class="panel-count">1<\/span>/);
  });

  it("escapes key names in the confirm data attributes", async () => {
    const { cookie, csrf } = await session();
    await postForm("/keys", cookie, { _csrf: csrf, name: `"><img src=x onerror=alert(1)>` });
    const html = await getKeys(cookie);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /data-confirm-name="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  });

  it("shows the empty row once every key is revoked", async () => {
    const { cookie, csrf } = await session();
    let html = await getKeys(cookie);
    for (const [, action] of html.matchAll(/action="(\/keys\/[^"/]+\/revoke)"/g)) {
      assert.ok(action);
      const res = await postForm(action, cookie, { _csrf: csrf });
      assert.equal(res.statusCode, 302);
    }
    html = await getKeys(cookie);
    assert.match(html, /<span class="panel-count">0<\/span>/);
    assert.match(html, /<tr class="empty-row"><td colspan="4">No keys\.<\/td><\/tr>/);
  });
});
