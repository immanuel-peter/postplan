import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { hashToken } from "../../src/lib/tokens.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import { apiHost, auth, multipart, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// Same production-style origin and cookie as dashboard-guard.test.ts.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";

type AssetBody = { id: string; filename: string | null; description: string | null };

/** The <tr> in the assets table whose filename link shows `filename`. */
function rowFor(html: string, filename: string): string {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find((r) => r.includes(`class="asset-filename"`) && r.includes(`>${filename}</a>`));
  assert.ok(row, `no table row for ${filename}`);
  return row;
}

describe("dashboard assets page", { skip: skipWithoutDb }, () => {
  let t: TestApp;
  let session: { cookie: string; csrf: string };

  before(async () => {
    t = await startTestApp();
    const { token } = await createSession({ db: t.db, pepper: t.config.tokenPepper, userAgent: "test" });
    const record = await authenticateSession({ db: t.db, pepper: t.config.tokenPepper, token });
    assert.ok(record);
    session = { cookie: `${COOKIE}=${token}`, csrf: hashToken(`csrf:${record.id}`, t.config.tokenPepper) };
  });
  after(async () => {
    await t?.close();
  });

  async function page(url = "/assets"): Promise<string> {
    const res = await t.app.inject({ method: "GET", url, headers: { ...apiHost(), cookie: session.cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return res.body;
  }

  async function apiUpload(filename: string, contentType: string, data: string, description?: string) {
    const form = multipart([
      { name: "file", filename, contentType, data },
      ...(description === undefined ? [] : [{ name: "description", value: description }]),
    ]);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...apiHost(), ...auth, ...form.headers },
      payload: form.payload,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<AssetBody>();
  }

  it("shows the upload bar and an empty table before anything is uploaded", async () => {
    const html = await page();
    assert.match(html, /<section class="dropbar" id="dropzone" aria-label="Upload">/);
    assert.match(html, /<svg class="dropbar-icon" width="22" height="22"/);
    assert.match(html, /<strong>Drop files here<\/strong> <span class="dropbar-sub">/);
    assert.match(html, /<button type="button" class="btn btn-secondary"[^>]*>Browse files<\/button>/);
    assert.match(html, /<input id="file-input" type="file" multiple hidden \/>/);
    assert.match(html, /id="assets-error"[^>]*hidden/);
    assert.ok(html.includes(JSON.stringify(session.csrf)), "upload script posts the session's CSRF token");

    assert.match(html, /<span class="panel-count">0 files · 0 B<\/span>/);
    assert.match(html, /<table class="data-table assets-table">/);
    assert.match(html, /<tr class="empty-row"><td colspan="4">No assets yet\. Drop a file above or upload with curl\.<\/td><\/tr>/);
    assert.doesNotMatch(html, /file\(s\)/);
    assert.doesNotMatch(html, /assets-grid|asset-card|class="dropzone"/, "old grid and dropzone markup is gone");
  });

  it("lists assets with name, description, type, size, and a local-time stamp", async () => {
    const png = await apiUpload("chart.png", "image/png", "\x89PNG fake", "Layer 4 <head 2> & friends");

    const one = await page();
    assert.match(one, /<span class="panel-count">1 file · \d+ B<\/span>/);
    assert.doesNotMatch(one, /file\(s\)/);
    assert.doesNotMatch(one, /empty-row/);

    const row = rowFor(one, "chart.png");
    assert.ok(row.includes(`<a class="thumb-sm" href="/assets/${png.id}" aria-label="Open chart.png">`));
    assert.match(row, /<img src="https:\/\/assets\.postplan\.test\/[^"]+\.png" alt="" loading="lazy" \/>/);
    assert.ok(row.includes(`<a class="asset-filename" href="/assets/${png.id}" title="chart.png">chart.png</a>`));
    assert.ok(
      row.includes(
        `<div class="cell-sub" title="Layer 4 &lt;head 2&gt; &amp; friends">Layer 4 &lt;head 2&gt; &amp; friends</div>`,
      ),
      "description is shown and escaped",
    );
    assert.doesNotMatch(row, /<head 2>/);
    assert.match(row, /<span class="ext-tag">PNG<\/span>/);
    assert.match(row, /<td class="col-size hide-xs">\d+ B<\/td>/);
    assert.match(row, /<div class="row-meta">/);
    const stamps = row.match(/<time datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" data-local>\d{4}-\d\d-\d\d \d\d:\d\d<\/time>/g);
    assert.equal(stamps?.length, 2, "one stamp in the Uploaded column, one in the phone meta line");
  });

  it("counts two files after a dashboard upload and handles names without an extension", async () => {
    const form = multipart([
      { name: "_csrf", value: session.csrf },
      { name: "file", filename: "README", contentType: "text/plain", data: "hello" },
    ]);
    const uploaded = await t.app.inject({
      method: "POST",
      url: "/assets",
      headers: { ...apiHost(), cookie: session.cookie, origin: ORIGIN, ...form.headers },
      payload: form.payload,
    });
    assert.equal(uploaded.statusCode, 302, uploaded.body);
    assert.equal(uploaded.headers.location, "/assets");

    const two = await page();
    assert.match(two, /<span class="panel-count">2 files · \d+ B<\/span>/);
    assert.doesNotMatch(two, /file\(s\)/);
    assert.ok(two.includes(">chart.png</a>"));

    const row = rowFor(two, "README");
    assert.match(row, /<span class="thumb-icon">\s*<svg width="18" height="18"/);
    assert.doesNotMatch(row, /cell-sub/, "no description line when the asset has none");
    assert.doesNotMatch(row, /ext-tag/);
    assert.match(row, /<td class="col-type hide-sm">\s*<span class="muted">—<\/span>/);
  });

  it("stamps the upload time on the detail page for local rendering", async () => {
    const asset = await apiUpload("clip.mp4", "video/mp4", "not really a video");
    const list = await page();
    const row = rowFor(list, "clip.mp4");
    assert.match(row, /<video src="[^"]+\.mp4" muted preload="metadata" playsinline><\/video>/);
    assert.match(row, /<span class="play-overlay" aria-hidden="true"><\/span>/);

    const detail = await page(`/assets/${asset.id}`);
    assert.match(
      detail,
      /<td class="muted mono"><time datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" data-local>\d{4}-\d\d-\d\d \d\d:\d\d<\/time><\/td>/,
    );
    assert.match(detail, /<script src="\/static\/localtime\.js" defer><\/script>/);
  });
});
