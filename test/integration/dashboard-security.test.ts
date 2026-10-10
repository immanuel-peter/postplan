import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { adminSetup } from "../../src/db/schema.js";
import { hashToken } from "../../src/lib/tokens.js";
import {
  addCredential,
  authenticateSession,
  createSession,
  markCredentialUsed,
} from "../../src/services/admin.js";
import { apiHost, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// See dashboard-guard.test.ts: a non-.localhost base domain outside development is production.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";

const REMOVED_UNLOCK_COPY = [
  "Unlock PostPlan",
  "This dashboard is private. Verify with a passkey to continue.",
  "Touch ID, or your device password if you prefer.",
  "Published Drafts and Assets stay public. Only the dashboard is locked.",
];

async function closeSetup(t: TestApp): Promise<void> {
  await t.db.insert(adminSetup).values({ id: "singleton", closedAt: new Date() });
}

describe("security and unlock pages", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
    await closeSetup(t);
  });
  after(async () => {
    await t?.close();
  });

  async function session(userAgent = "test") {
    const { token } = await createSession({ db: t.db, pepper: t.config.tokenPepper, userAgent });
    const record = await authenticateSession({ db: t.db, pepper: t.config.tokenPepper, token });
    assert.ok(record);
    return {
      id: record.id,
      cookie: `${COOKIE}=${token}`,
      csrf: hashToken(`csrf:${record.id}`, t.config.tokenPepper),
    };
  }

  async function getSecurity(cookie: string) {
    const res = await t.app.inject({ method: "GET", url: "/security", headers: { ...apiHost(), cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return res.body;
  }

  it("greets with Welcome! and none of the removed unlock copy", async () => {
    const res = await t.app.inject({ method: "GET", url: "/unlock", headers: apiHost() });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /<h1 class="unlock-title">Welcome!<\/h1>/);
    for (const sentence of REMOVED_UNLOCK_COPY) {
      assert.ok(!res.body.includes(sentence), `still shows "${sentence}"`);
    }
    // The note only appears while the browser is waiting on the passkey prompt.
    assert.match(res.body, /<p class="note" id="unlock-note" hidden><\/p>/);
    assert.match(res.body, /Your browser is asking for verification\. Finish it there\./);
    // Without a recovery secret there is nothing to put in the footer.
    assert.doesNotMatch(res.body, /gate-foot/);
    assert.doesNotMatch(res.body, /Lost every passkey/);
  });

  it("shows one passkey without a Remove button or the lock-out warning", async () => {
    const only = await addCredential(t.db, {
      credentialId: "cred-only",
      publicKey: "pk",
      counter: 0,
      transports: ["internal", "hybrid"],
      name: "MacBook Pro",
    });
    await markCredentialUsed(t.db, only.id, 1);
    const { cookie } = await session();
    const html = await getSecurity(cookie);

    assert.match(html, /<h1>Security<\/h1>/);
    assert.match(html, /<p class="lede">Passkeys that can unlock this dashboard/);
    assert.match(html, /<p class="alert-error" id="passkey-error" hidden><\/p>/);
    assert.match(html, /<div class="cell-title">MacBook Pro<\/div>/);
    assert.doesNotMatch(html, /internal/);
    assert.doesNotMatch(html, /hybrid/);
    assert.doesNotMatch(html, />Remove</);
    assert.doesNotMatch(html, /Your only passkey cannot be removed/);
    assert.match(html, /<p class="panel-foot">Adding a passkey asks for Touch ID again first\.<\/p>/);
    assert.match(
      html,
      /<button class="btn btn-dark" type="button" id="add-passkey">\s*<svg[\s\S]*?<\/svg>\s*<span>Add a passkey<\/span>/,
    );
    // Added and last used (column, plus the phone-width row-meta copy) carry ISO stamps for localtime.js.
    assert.equal(
      html.match(/<time datetime="\d{4}-\d\d-\d\dT[^"]+Z" data-local>\d{4}-\d\d-\d\d \d\d:\d\d<\/time>/g)?.length,
      3,
    );
    assert.match(html, /<div class="row-meta">\s*Last used <time datetime="[^"]+" data-local>/);
  });

  it("offers Remove on every passkey once there are two, and says Never for an unused one", async () => {
    await addCredential(t.db, {
      credentialId: "cred-backup",
      publicKey: "pk",
      counter: 0,
      transports: ["usb"],
      name: "YubiKey",
    });
    const { cookie } = await session();
    const html = await getSecurity(cookie);

    assert.equal(
      html.match(/<button class="btn btn-sm btn-danger-soft" type="submit" aria-label="Remove [^"]+">Remove<\/button>/g)
        ?.length,
      2,
    );
    assert.match(
      html,
      /<div class="cell-title">YubiKey<\/div>\s*<div class="row-meta">\s*Never used\s*<\/div>[\s\S]*?<td class="col-time hide-xs">\s*Never\s*<\/td>/,
    );
    assert.doesNotMatch(html, /usb/);
  });

  it("lists sessions without a Signed in column and with a destructive sign-out-everywhere", async () => {
    const other = await session("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/131.0");
    const current = await session();
    const html = await getSecurity(current.cookie);

    assert.doesNotMatch(html, /Signed in</);
    assert.match(
      html,
      /<th scope="col">Browser<\/th>\s*<th scope="col" class="col-time hide-xs">Expires<\/th>\s*<th scope="col" class="col-action">/,
    );
    assert.match(html, /<div class="row-meta">\s*Expires <time datetime="[^"]+" data-local>in 7 days<\/time>/);
    assert.match(
      html,
      /<form method="post" action="\/security\/sessions\/revoke-all">\s*<input type="hidden" name="_csrf" value="[^"]+" \/>\s*<button class="btn btn-danger" type="submit">\s*<svg[\s\S]*?<\/svg>\s*<span>Sign out everywhere<\/span>/,
    );
    assert.doesNotMatch(html, /class="link-button"/);
    assert.match(html, /<time datetime="\d{4}-\d\d-\d\dT[^"]+Z" data-local>in 7 days<\/time>/);
    assert.match(html, /<p class="panel-foot">Sessions last 7 days\. Locking ends this one only\.<\/p>/);

    // The current session has an empty action cell; the other one can be revoked.
    assert.match(html, /<span class="chip-dirty">This device<\/span>/);
    assert.doesNotMatch(html, new RegExp(`/security/sessions/${current.id}/revoke`));
    assert.match(
      html,
      new RegExp(
        `action="/security/sessions/${other.id}/revoke">\\s*<input type="hidden" name="_csrf" value="[^"]+" />\\s*` +
          `<button class="btn btn-sm btn-danger-soft" type="submit" aria-label="Revoke Firefox · macOS">Revoke</button>`,
      ),
    );

    const revoked = await t.app.inject({
      method: "POST",
      url: `/security/sessions/${other.id}/revoke`,
      headers: { ...apiHost(), cookie: current.cookie, origin: ORIGIN },
      payload: { _csrf: current.csrf },
    });
    assert.equal(revoked.statusCode, 302);
    assert.equal(revoked.headers.location, "/security");
    assert.doesNotMatch(await getSecurity(current.cookie), new RegExp(other.id));

    const everywhere = await t.app.inject({
      method: "POST",
      url: "/security/sessions/revoke-all",
      headers: { ...apiHost(), cookie: current.cookie, origin: ORIGIN },
      payload: { _csrf: current.csrf },
    });
    assert.equal(everywhere.statusCode, 302);
    assert.equal(everywhere.headers.location, "/unlock");
    const locked = await t.app.inject({ method: "GET", url: "/security", headers: { ...apiHost(), cookie: current.cookie } });
    assert.equal(locked.statusCode, 302);
  });
});

describe("unlock page with a recovery secret", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp({ adminRecoverySecret: "test-recovery-secret" });
    await closeSetup(t);
  });
  after(async () => {
    await t?.close();
  });

  it("keeps only the recovery footer", async () => {
    const res = await t.app.inject({ method: "GET", url: "/unlock", headers: apiHost() });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /Welcome!/);
    assert.match(
      res.body,
      /<div class="gate-foot">\s*<p class="note">Lost every passkey\? <a href="\/setup">Use your recovery secret<\/a> to enroll a replacement\.<\/p>\s*<\/div>/,
    );
    for (const sentence of REMOVED_UNLOCK_COPY) {
      assert.ok(!res.body.includes(sentence), `still shows "${sentence}"`);
    }
  });
});
