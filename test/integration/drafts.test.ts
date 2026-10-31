import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  apiHost,
  auth,
  draftHost,
  htmlDoc,
  multipart,
  skipWithoutDb,
  startTestApp,
  type TestApp,
} from "../helpers/app.js";

type DraftBody = {
  id: string;
  slug: string;
  title: string | null;
  currentVersion: number;
  publicUrl: string;
  versionUrl: string;
  contentSha256: string;
  gitRef: string | null;
  gitCommit: string | null;
};

describe("draft lifecycle", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t?.close();
  });

  async function createDraft(html: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const form = multipart([
      { name: "html", filename: "page.html", contentType: "text/html", data: html },
      ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ]);
    return t.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: { ...apiHost(), ...auth, ...form.headers, ...headers },
      payload: form.payload,
    });
  }

  async function addVersion(id: string, html: string, headers: Record<string, string>) {
    const form = multipart([{ name: "html", filename: "page.html", contentType: "text/html", data: html }]);
    return t.app.inject({
      method: "POST",
      url: `/api/v1/drafts/${id}/versions`,
      headers: { ...apiHost(), ...auth, ...form.headers, ...headers },
      payload: form.payload,
    });
  }

  it("creates, serves, versions, and pins a draft", async () => {
    const v1 = htmlDoc("<h1>v1</h1>");
    const created = await createDraft(v1, { title: "Attention", git_ref: "main", git_commit: "abc123" });
    assert.equal(created.statusCode, 201, created.body);
    const draft = created.json<DraftBody>();
    assert.equal(draft.currentVersion, 1);
    assert.equal(draft.title, "Attention");
    assert.equal(draft.gitRef, "main");
    assert.equal(draft.publicUrl, `https://${draft.slug}.postplan.test/`);
    assert.equal(draft.versionUrl, `https://${draft.slug}.postplan.test/v/1`);
    assert.ok(t.s3.has(t.config.s3Bucket, `drafts/${draft.id}/versions/1.html`));

    const latest = await t.app.inject({ method: "GET", url: "/", headers: draftHost(draft.slug) });
    assert.equal(latest.statusCode, 200);
    assert.equal(latest.body, v1);
    assert.match(latest.headers["content-type"] ?? "", /^text\/html/);
    assert.equal(latest.headers.etag, `"${draft.id}-1"`);
    assert.equal(latest.headers["cache-control"], "public, max-age=60, must-revalidate");
    assert.equal(latest.headers["x-frame-options"], "DENY");
    assert.match(String(latest.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(latest.headers["content-security-policy"]), /https:\/\/assets\.postplan\.test/);

    const v2 = htmlDoc("<h1>v2</h1>");
    const bumped = await addVersion(draft.id, v2, { "if-match": '"1"' });
    assert.equal(bumped.statusCode, 201, bumped.body);
    assert.equal(bumped.json<DraftBody>().currentVersion, 2);

    const latest2 = await t.app.inject({ method: "GET", url: "/", headers: draftHost(draft.slug) });
    assert.equal(latest2.body, v2);
    assert.equal(latest2.headers.etag, `"${draft.id}-2"`);

    const pinned = await t.app.inject({ method: "GET", url: "/v/1", headers: draftHost(draft.slug) });
    assert.equal(pinned.statusCode, 200);
    assert.equal(pinned.body, v1, "old versions stay immutable");
    assert.equal(pinned.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(pinned.headers.etag, `"${draft.contentSha256}"`);

    const versions = await t.app.inject({
      method: "GET",
      url: `/api/v1/drafts/${draft.id}/versions`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(versions.statusCode, 200);
    assert.deepEqual(
      versions.json<Array<{ versionNumber: number }>>().map((v) => v.versionNumber).sort(),
      [1, 2],
    );
  });

  it("answers 304 for a matching If-None-Match", async () => {
    const draft = (await createDraft(htmlDoc("cache"))).json<DraftBody>();
    const first = await t.app.inject({ method: "GET", url: "/", headers: draftHost(draft.slug) });
    const etag = String(first.headers.etag);

    const again = await t.app.inject({
      method: "GET",
      url: "/",
      headers: { ...draftHost(draft.slug), "if-none-match": etag },
    });
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, "");

    const pinnedEtag = `"${draft.contentSha256}"`;
    const pinned = await t.app.inject({
      method: "GET",
      url: "/v/1",
      headers: { ...draftHost(draft.slug), "if-none-match": `"other", ${pinnedEtag}` },
    });
    assert.equal(pinned.statusCode, 304);
  });

  it("enforces optimistic concurrency on new versions", async () => {
    const draft = (await createDraft(htmlDoc("occ"))).json<DraftBody>();

    const missing = await addVersion(draft.id, htmlDoc("x"), {});
    assert.equal(missing.statusCode, 428);

    const garbage = await addVersion(draft.id, htmlDoc("x"), { "if-match": '"zero"' });
    assert.equal(garbage.statusCode, 400);

    const stale = await addVersion(draft.id, htmlDoc("x"), { "if-match": '"7"' });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json<{ currentVersion: number }>().currentVersion, 1);

    const ok = await addVersion(draft.id, htmlDoc("y"), { "if-match": '"1"' });
    assert.equal(ok.statusCode, 201);

    const replay = await addVersion(draft.id, htmlDoc("z"), { "if-match": '"1"' });
    assert.equal(replay.statusCode, 409, "a second writer on the same base version loses");
  });

  it("replays idempotent creates and rejects key reuse with a different body", async () => {
    const key = { "idempotency-key": "create-once" };
    const first = await createDraft(htmlDoc("idem"), { title: "one" }, key);
    const second = await createDraft(htmlDoc("idem"), { title: "one" }, key);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.json<DraftBody>().id, first.json<DraftBody>().id);

    const conflict = await createDraft(htmlDoc("different"), { title: "one" }, key);
    assert.equal(conflict.statusCode, 409);
  });

  it("rejects bad html and missing files", async () => {
    const invalid = await createDraft("\u0000");
    assert.equal(invalid.statusCode, 400);

    const form = multipart([{ name: "title", value: "no file" }]);
    const noFile = await t.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: { ...apiHost(), ...auth, ...form.headers },
      payload: form.payload,
    });
    assert.equal(noFile.statusCode, 400);
  });

  it("patches metadata and soft-deletes", async () => {
    const draft = (await createDraft(htmlDoc("meta"), { title: "before" })).json<DraftBody>();

    const patched = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/drafts/${draft.id}`,
      headers: { ...apiHost(), ...auth },
      payload: { title: "after" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json<DraftBody>().title, "after");

    const deleted = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/drafts/${draft.id}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(deleted.statusCode, 204);

    const publicAfter = await t.app.inject({ method: "GET", url: "/", headers: draftHost(draft.slug) });
    assert.equal(publicAfter.statusCode, 404);

    const versionAfter = await addVersion(draft.id, htmlDoc("zombie"), { "if-match": '"1"' });
    assert.equal(versionAfter.statusCode, 404);

    const listed = await t.app.inject({
      method: "GET",
      url: "/api/v1/drafts?status=deleted",
      headers: { ...apiHost(), ...auth },
    });
    assert.ok(listed.json<{ items: DraftBody[] }>().items.some((item) => item.id === draft.id));
  });

  it("paginates the draft list", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createDraft(htmlDoc(`page ${i}`));
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = await t.app.inject({
        method: "GET",
        url: `/api/v1/drafts?limit=2${query}`,
        headers: { ...apiHost(), ...auth },
      });
      assert.equal(page.statusCode, 200, page.body);
      const body = page.json<{ items: DraftBody[]; nextCursor: string | null }>();
      assert.ok(body.items.length <= 2);
      for (const item of body.items) {
        assert.ok(!seen.has(item.id), "pages must not overlap");
        seen.add(item.id);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    assert.ok(seen.size >= 3);
    assert.ok(pages >= 2);

    const bad = await t.app.inject({
      method: "GET",
      url: "/api/v1/drafts?limit=0",
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(bad.statusCode, 400);
  });

  it("searches the draft list with ?q=", async () => {
    const alpha = (
      await createDraft(htmlDoc("search alpha"), {
        title: "Quarterly Alpha",
        description: "launch checklist",
        repository_name: "acme/corp-site",
      })
    ).json<DraftBody>();
    await createDraft(htmlDoc("search beta"), { title: "Beta Page" });
    const punct = (await createDraft(htmlDoc("search punct"), { title: "50%_off" })).json<DraftBody>();
    const slash = (await createDraft(htmlDoc("search slash"), { title: "back\\slash" })).json<DraftBody>();

    async function list(query: string) {
      const res = await t.app.inject({
        method: "GET",
        url: `/api/v1/drafts?${query}`,
        headers: { ...apiHost(), ...auth },
      });
      assert.equal(res.statusCode, 200, res.body);
      return res.json<{ items: DraftBody[]; nextCursor: string | null }>();
    }
    async function ids(query: string) {
      return (await list(query)).items.map((item) => item.id);
    }

    assert.deepEqual(await ids("q=alpha"), [alpha.id]);
    assert.deepEqual(await ids("q=checklist"), [alpha.id], "matches description");
    assert.deepEqual(await ids("q=corp-site"), [alpha.id], "matches repositoryName");

    assert.deepEqual(await ids("q=quarterly%20alpha"), [alpha.id], "words AND together");
    assert.deepEqual(await ids("q=quarterly%20beta"), [], "a word matching nothing fails the AND");
    assert.deepEqual(await ids("q=QUARTERLY"), [alpha.id], "case-insensitive");

    assert.deepEqual(await ids("q=%25"), [punct.id], "% is literal, not a wildcard");
    assert.deepEqual(await ids("q=50%25_off"), [punct.id], "_ is literal, not a wildcard");
    assert.deepEqual(await ids("q=back%5Cslash"), [slash.id], "\\ matches a literal backslash");

    const none = await list("q=nosuchword");
    assert.deepEqual(none.items, []);
    assert.equal(none.nextCursor, null);
  });

  it("paginates ?q= results within the filtered set", async () => {
    for (let i = 0; i < 3; i += 1) {
      await createDraft(htmlDoc(`wander ${i}`), { title: `Wanderer ${i}` });
    }
    await createDraft(htmlDoc("static"), { title: "Static" });

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const cursorQuery: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = await t.app.inject({
        method: "GET",
        url: `/api/v1/drafts?q=wander&limit=2${cursorQuery}`,
        headers: { ...apiHost(), ...auth },
      });
      assert.equal(page.statusCode, 200, page.body);
      const body = page.json<{ items: DraftBody[]; nextCursor: string | null }>();
      assert.ok(body.items.length <= 2);
      for (const item of body.items) {
        assert.match(item.title ?? "", /Wanderer/, "pages must stay inside the ?q= set");
        assert.ok(!seen.has(item.id), "pages must not overlap");
        seen.add(item.id);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    assert.equal(seen.size, 3);
  });

  it("lists each draft with its latest version", async () => {
    const multi = (await createDraft(htmlDoc("multi v1"))).json<DraftBody>();
    assert.equal((await addVersion(multi.id, htmlDoc("multi v2"), { "if-match": '"1"' })).statusCode, 201);
    assert.equal((await addVersion(multi.id, htmlDoc("multi v3"), { "if-match": '"2"' })).statusCode, 201);
    const single = (await createDraft(htmlDoc("single v1"))).json<DraftBody>();

    const listed = await t.app.inject({
      method: "GET",
      url: "/api/v1/drafts?limit=100",
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const items = listed.json<{ items: DraftBody[] }>().items;
    const multiItem = items.find((item) => item.id === multi.id);
    const singleItem = items.find((item) => item.id === single.id);
    assert.equal(multiItem?.currentVersion, 3);
    assert.equal(multiItem?.versionUrl, `https://${multi.slug}.postplan.test/v/3`);
    assert.equal(singleItem?.currentVersion, 1);
  });

  it("rejects version numbers beyond the safe integer range", async () => {
    const draft = (await createDraft(htmlDoc("huge"))).json<DraftBody>();
    const huge = "99999999999999999999";

    const api = await t.app.inject({
      method: "GET",
      url: `/api/v1/drafts/${draft.id}/versions/${huge}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(api.statusCode, 400, api.body);

    const pub = await t.app.inject({ method: "GET", url: `/v/${huge}`, headers: draftHost(draft.slug) });
    assert.equal(pub.statusCode, 404);
  });

  it("404s unknown slugs, bad version paths, and stray paths on draft hosts", async () => {
    const draft = (await createDraft(htmlDoc("paths"))).json<DraftBody>();
    for (const url of ["/v/0", "/v/2", "/v/abc", "/anything"]) {
      const res = await t.app.inject({ method: "GET", url, headers: draftHost(draft.slug) });
      assert.equal(res.statusCode, 404, url);
    }
    const unknown = await t.app.inject({ method: "GET", url: "/", headers: draftHost("nosuchslug") });
    assert.equal(unknown.statusCode, 404);

    const apiOnDraftHost = await t.app.inject({
      method: "GET",
      url: "/api/v1/drafts",
      headers: { ...draftHost(draft.slug), ...auth },
    });
    assert.equal(apiOnDraftHost.statusCode, 404, "the API must not answer on draft subdomains");
  });
});
