import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { hashToken } from "../../src/lib/tokens.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import { apiHost, auth, htmlDoc, multipart, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// Same production-style origin and cookie as dashboard-guard.test.ts.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";

type DraftBody = {
  id: string;
  slug: string;
  updatedAt: string;
};

type ListRow = {
  id: string;
  classes: string[];
  pressed: string;
  html: string;
};

/** The draft rows of the list page, in order, keyed by the id in each row's star form. */
function listRows(html: string): ListRow[] {
  const tbody = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  const rows: ListRow[] = [];
  for (const match of tbody.matchAll(/<tr(?: class="([^"]*)")?>([\s\S]*?)<\/tr>/g)) {
    const body = match[2] ?? "";
    const id = /action="\/drafts\/([^/"]+)\/favorite"/.exec(body)?.[1];
    if (id === undefined) {
      continue;
    }
    rows.push({
      id,
      classes: (match[1] ?? "").split(" ").filter(Boolean),
      pressed: /aria-pressed="(true|false)"/.exec(body)?.[1] ?? "",
      html: body,
    });
  }
  return rows;
}

describe("dashboard drafts list", { skip: skipWithoutDb }, () => {
  let t: TestApp;
  let cookie: string;
  let csrf: string;

  before(async () => {
    t = await startTestApp();
    const { token } = await createSession({ db: t.db, pepper: t.config.tokenPepper, userAgent: "test" });
    const record = await authenticateSession({ db: t.db, pepper: t.config.tokenPepper, token });
    assert.ok(record);
    cookie = `${COOKIE}=${token}`;
    csrf = hashToken(`csrf:${record.id}`, t.config.tokenPepper);
  });
  after(async () => {
    await t?.close();
  });

  async function createDraft(fields: Record<string, string> = {}): Promise<DraftBody> {
    // Keep updatedAt strictly increasing so the list order is deterministic.
    await sleep(5);
    const form = multipart([
      { name: "html", filename: "page.html", contentType: "text/html", data: htmlDoc("draft") },
      ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ]);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: { ...apiHost(), ...auth, ...form.headers },
      payload: form.payload,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<DraftBody>();
  }

  async function apiDraft(id: string): Promise<DraftBody & Record<string, unknown>> {
    const res = await t.app.inject({ method: "GET", url: `/api/v1/drafts/${id}`, headers: { ...apiHost(), ...auth } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json<DraftBody & Record<string, unknown>>();
  }

  async function page(url = "/") {
    const res = await t.app.inject({ method: "GET", url, headers: { ...apiHost(), cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return res.body;
  }

  function star(id: string, payload: Record<string, string>) {
    return t.app.inject({
      method: "POST",
      url: `/drafts/${id}/favorite`,
      headers: { ...apiHost(), cookie, origin: ORIGIN },
      payload: { _csrf: csrf, ...payload },
    });
  }

  it("shows the empty state before any drafts exist", async () => {
    const html = await page();
    assert.match(html, /<h1>Drafts<\/h1>/);
    assert.match(html, /No drafts yet\. Publish one with curl and a Token\./);
    assert.match(html, /<span>All<\/span>\s*<span class="count">0<\/span>/);
  });

  let github: DraftBody;
  let plain: DraftBody;
  let versioned: DraftBody;

  it("renders one flat list, newest first, without repository groups", async () => {
    github = await createDraft({
      title: "Attention notes",
      description: "Heatmaps you can hover",
      repository_name: "acme/widgets",
      repository_url: "https://github.com/acme/widgets",
    });
    plain = await createDraft({ title: "Reading list" });
    versioned = await createDraft({ title: "Garage notes", repository_url: "https://git.example.com/ops/homelab.git" });
    const form = multipart([{ name: "html", filename: "page.html", contentType: "text/html", data: htmlDoc("v2") }]);
    const bumped = await t.app.inject({
      method: "POST",
      url: `/api/v1/drafts/${versioned.id}/versions`,
      headers: { ...apiHost(), ...auth, ...form.headers, "if-match": '"1"' },
      payload: form.payload,
    });
    assert.equal(bumped.statusCode, 201, bumped.body);

    const html = await page();
    assert.match(html, /<title>Drafts · PostPlan<\/title>/);
    assert.match(html, /<h1>Drafts<\/h1>/);
    assert.doesNotMatch(html, /My drafts/);
    assert.doesNotMatch(html, /No repository/);
    assert.doesNotMatch(html, /class="group/);
    assert.doesNotMatch(html, /\d+ versions?\b/, "only the vN label, no version count");
    assert.match(html, /<td class="col-version hide-md">v2<\/td>/);
    assert.match(html, /<span>All<\/span>\s*<span class="count">3<\/span>/);
    assert.match(html, /<span>Favorites<\/span>\s*<span class="count">0<\/span>/);
    assert.match(html, /<a href="\/" aria-current="page">/);

    const rows = listRows(html);
    assert.deepEqual(
      rows.map((row) => row.id),
      [versioned.id, plain.id, github.id],
      "most recently updated first",
    );
    for (const row of rows) {
      assert.equal(row.pressed, "false");
      assert.deepEqual(row.classes, []);
      assert.match(row.html, /<input type="hidden" name="favorite" value="1" \/>/);
      assert.doesNotMatch(row.html, /name="show"/);
      assert.match(row.html, new RegExp(`<a href="/drafts/${row.id}">Details</a>`));
      assert.match(row.html, /<time datetime="\d{4}-\d{2}-\d{2}T[\d:.]+Z" data-local>\d{4}-\d{2}-\d{2} \d{2}:\d{2}<\/time>/);
    }

    const [versionedRow, plainRow, githubRow] = rows;
    assert.match(githubRow?.html ?? "", /href="https:\/\/github\.com\/acme\/widgets"/);
    assert.match(githubRow?.html ?? "", /aria-label="acme\/widgets on GitHub"/);
    assert.match(
      githubRow?.html ?? "",
      /<span class="repo-owner">acme<\/span><span class="repo-name"><span class="repo-owner-sep">\/<\/span>widgets<\/span>/,
    );
    assert.match(githubRow?.html ?? "", /<div class="draft-desc" title="Heatmaps you can hover">Heatmaps you can hover<\/div>/);
    assert.match(plainRow?.html ?? "", /<span class="muted">—<\/span>/);
    assert.doesNotMatch(plainRow?.html ?? "", /draft-desc/);
    // No repository name: owner and name come from the URL path, minus ".git".
    assert.match(
      versionedRow?.html ?? "",
      /<span class="repo-owner">ops<\/span><span class="repo-name"><span class="repo-owner-sep">\/<\/span>homelab<\/span>/,
    );
    assert.doesNotMatch(versionedRow?.html ?? "", /on GitHub/);
  });

  it("stars a draft, pins it to the top, and leaves updatedAt alone", async () => {
    const before = await apiDraft(github.id);

    const res = await star(github.id, { favorite: "1" });
    assert.equal(res.statusCode, 302, res.body);
    assert.equal(res.headers.location, "/");

    const rows = listRows(await page());
    assert.deepEqual(rows.map((row) => row.id), [github.id, versioned.id, plain.id]);
    assert.equal(rows[0]?.pressed, "true");
    assert.match(rows[0]?.html ?? "", /aria-label="Remove from favorites"/);
    assert.match(rows[0]?.html ?? "", /<input type="hidden" name="favorite" value="0" \/>/);
    assert.deepEqual(rows[0]?.classes, ["is-favorite"]);
    assert.deepEqual(rows[1]?.classes, ["after-favorites"]);
    assert.deepEqual(rows[2]?.classes, []);
    assert.equal(rows[1]?.pressed, "false");

    const afterStar = await apiDraft(github.id);
    assert.equal(afterStar.updatedAt, before.updatedAt, "starring is not a content edit");
    assert.ok(!("favorite" in afterStar), "the public API shape is unchanged");
  });

  it("filters to favorites and keeps the filter across a star toggle", async () => {
    const html = await page("/?show=favorites");
    assert.match(html, /<a href="\/\?show=favorites" aria-current="page">/);
    assert.match(html, /<span>All<\/span>\s*<span class="count">3<\/span>/);
    assert.match(html, /<span>Favorites<\/span>\s*<span class="count">1<\/span>/);
    const rows = listRows(html);
    assert.deepEqual(rows.map((row) => row.id), [github.id]);
    assert.deepEqual(rows[0]?.classes, [], "no pinned tint when every row is a favorite");
    assert.match(rows[0]?.html ?? "", /<input type="hidden" name="show" value="favorites" \/>/);

    const unstar = await star(github.id, { favorite: "0", show: "favorites" });
    assert.equal(unstar.statusCode, 302, unstar.body);
    assert.equal(unstar.headers.location, "/?show=favorites");

    const empty = await page("/?show=favorites");
    assert.deepEqual(listRows(empty), []);
    assert.match(empty, /No favorites yet\. Star a draft to pin it to the top\./);
    assert.doesNotMatch(empty, /No drafts yet/);

    const all = listRows(await page());
    assert.deepEqual(all.map((row) => row.id), [versioned.id, plain.id, github.id]);
    assert.ok(all.every((row) => row.pressed === "false" && row.classes.length === 0));
  });

  it("treats any other show value as the full list", async () => {
    const rows = listRows(await page("/?show=nope"));
    assert.equal(rows.length, 3);

    const res = await star(plain.id, { favorite: "1", show: "https://evil.test/" });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/", "the redirect never leaves the two list views");

    const loose = await star(plain.id, { favorite: "yes" });
    assert.equal(loose.statusCode, 302);
    assert.equal(listRows(await page()).find((row) => row.id === plain.id)?.pressed, "false", "only \"1\" stars");
  });

  it("404s unknown and deleted drafts", async () => {
    const unknown = await star("01NOSUCHDRAFT", { favorite: "1" });
    assert.equal(unknown.statusCode, 404);

    const gone = await createDraft({ title: "Doomed" });
    const deleted = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/drafts/${gone.id}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(deleted.statusCode, 204);
    const res = await star(gone.id, { favorite: "1" });
    assert.equal(res.statusCode, 404);
  });

  it("rejects a star without CSRF or a session", async () => {
    const noCsrf = await t.app.inject({
      method: "POST",
      url: `/drafts/${plain.id}/favorite`,
      headers: { ...apiHost(), cookie, origin: ORIGIN },
      payload: { favorite: "1" },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.body, "bad csrf");

    const noSession = await t.app.inject({
      method: "POST",
      url: `/drafts/${plain.id}/favorite`,
      headers: { ...apiHost(), origin: ORIGIN },
      payload: { _csrf: csrf, favorite: "1" },
    });
    assert.equal(noSession.statusCode, 403);
    assert.equal(noSession.body, "locked");

    const row = listRows(await page()).find((item) => item.id === plain.id);
    assert.equal(row?.pressed, "false");
  });

  it("shows local-time stamps and the Drafts back link on the detail page", async () => {
    const html = await page(`/drafts/${versioned.id}`);
    assert.match(html, /<a class="back" href="\/">← Drafts<\/a>/);
    assert.doesNotMatch(html, /My drafts/);
    assert.match(html, /<table class="data-table versions-table">/);
    const stamps = [...html.matchAll(/<time datetime="[^"]+Z" data-local>/g)];
    assert.equal(stamps.length, 2, "one stamp per version");
  });
});
