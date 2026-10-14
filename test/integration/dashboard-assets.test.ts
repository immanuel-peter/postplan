import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq, ne } from "drizzle-orm";
import { parseFragment } from "parse5";
import { assets } from "../../src/db/schema.js";
import { hashToken } from "../../src/lib/tokens.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import { getAsset, getAssetNeighbors, type AssetRecord } from "../../src/services/assets.js";
import { apiHost, auth, multipart, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

// Same production-style origin and cookie as dashboard-guard.test.ts.
const ORIGIN = "https://postplan.test";
const COOKIE = "__Host-postplan_session";

type AssetBody = { id: string; url: string; filename: string | null; description: string | null };
type Snippets = { markdown: string; html: string; curl: string };

function referenceSnippets(html: string): Snippets {
  function text(kind: keyof Snippets): string {
    const match = html.match(new RegExp(`id="ref-${kind}"[^>]*>([\\s\\S]*?)</code>`));
    assert.ok(match, `missing ${kind} reference`);
    const nodes = parseFragment(match[1]!).childNodes;
    assert.ok(nodes.every((node) => node.nodeName === "#text"), "snippets must be escaped text");
    return nodes.map((node) => "value" in node ? node.value : "").join("");
  }
  return { markdown: text("markdown"), html: text("html"), curl: text("curl") };
}

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

  it("infers generic dashboard uploads and renders video and audio previews", async () => {
    for (const [filename, expectedType, tag] of [
      ["dashboard-clip.mp4", "video/mp4", "video"],
      ["dashboard-sound.mp3", "audio/mpeg", "audio"],
      ["dashboard-data.csv", "text/csv", null],
    ] as const) {
      const form = multipart([
        { name: "_csrf", value: session.csrf },
        { name: "file", filename, contentType: "application/octet-stream", data: "test content" },
      ]);
      const uploaded = await t.app.inject({
        method: "POST", url: "/assets",
        headers: { ...apiHost(), cookie: session.cookie, origin: ORIGIN, ...form.headers },
        payload: form.payload,
      });
      assert.equal(uploaded.statusCode, 302, uploaded.body);
      assert.equal(uploaded.headers.location, "/assets");

      const row = rowFor(await page(), filename);
      const id = /class="asset-filename" href="\/assets\/([^"]+)"/.exec(row)?.[1];
      assert.ok(id);
      const asset = await getAsset(t.db, id);
      assert.ok(!("kind" in asset));
      assert.equal(asset.contentType, expectedType, filename);
      const detail = await page(`/assets/${id}`);
      assert.ok(detail.includes(expectedType));
      if (tag) {
        assert.match(detail, new RegExp(`<${tag} src="[^"]+" controls`));
      }
    }
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
      /<td class="col-time hide-xs"><time datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" data-local>\d{4}-\d\d-\d\d \d\d:\d\d<\/time><\/td>/,
    );
    assert.match(detail, /<script src="\/static\/localtime\.js" defer><\/script>/);
  });

  it("shows the detail page with an in-place description, Reference rows, and no SHA", async () => {
    const asset = await apiUpload("heatmap.png", "image/png", "pixels", 'Layer "4" weights');
    const detail = await page(`/assets/${asset.id}`);

    // Description: inline field (no textarea) that posts back to the asset.
    assert.doesNotMatch(detail, /<textarea/);
    assert.match(detail, /<form class="desc-form" id="desc-form" method="post" action="\/assets\/[^"]+">/);
    assert.match(detail, /<span class="desc-text" id="desc-text">Layer &quot;4&quot; weights<\/span>/);
    assert.match(detail, /<input id="description" name="description" type="text" maxlength="2000" value="Layer &quot;4&quot; weights"/);

    // "Reference" replaces "Embed", without the Direct link row.
    assert.match(detail, /<h2 id="reference-title">Reference<\/h2>/);
    assert.doesNotMatch(detail, />Embed</);
    assert.doesNotMatch(detail, /Direct link/);
    for (const label of ["Markdown", "HTML", "curl"]) {
      assert.match(detail, new RegExp(`<span class="ref-label">${label}</span>`));
    }
    assert.match(detail, /data-snippet="html"[^>]*>&lt;img src=&quot;[^&]+&quot; alt=&quot;Layer &amp;quot;4&amp;quot; weights&quot;&gt;<\/code>/);

    // Details drop the SHA-256.
    assert.doesNotMatch(detail, /sha-?256/i);
    assert.match(
      detail,
      /<th scope="col">Type<\/th>\s*<th scope="col" class="col-size hide-xs">Size<\/th>\s*<th scope="col" class="col-time hide-xs">Uploaded<\/th>/,
    );

    // Delete is a destructive button that confirms in a dialog first.
    assert.match(detail, /<form method="post" action="\/assets\/[^"]+\/delete" id="delete-form">/);
    assert.match(detail, /<button class="btn btn-danger-soft" type="submit">/);
    assert.match(detail, /<dialog class="confirm" id="delete-dialog" aria-labelledby="delete-title">/);
    assert.match(detail, /<h2 id="delete-title">Delete “heatmap\.png”\?<\/h2>/);
    assert.doesNotMatch(detail, /link-button/);
  });

  for (const [filename, contentType, markdownPrefix, htmlTemplate] of [
    ["reference-image.png", "image/png", "!", '<img src="URL" alt="LABEL">'],
    ["reference-video.mp4", "video/mp4", "", '<video controls src="URL" title="LABEL"></video>'],
    ["reference-audio.mp3", "audio/mpeg", "", '<audio controls src="URL" title="LABEL"></audio>'],
    ["reference-document.pdf", "application/pdf", "", '<a href="URL">LABEL</a>'],
    ["reference-data.csv", "text/csv", "", '<a href="URL">LABEL</a>'],
    ["reference-archive.zip", "application/zip", "", '<a href="URL">LABEL</a>'],
  ] as const) {
    it(`keeps ${filename} references correct on load, inline save, and clearing the description`, async () => {
      const asset = await apiUpload(filename, contentType, "reference fixture");
      const fallback = filename.slice(0, filename.lastIndexOf("."));
      const expected = (label: string, markdownLabel = label): Snippets => ({
        markdown: `${markdownPrefix}[${markdownLabel}](${asset.url})`,
        html: htmlTemplate.replace("URL", asset.url).replace("LABEL", label),
        curl: `curl -O ${asset.url}`,
      });
      assert.deepEqual(referenceSnippets(await page(`/assets/${asset.id}`)), expected(fallback));

      const description = 'Edited [label] \\ "quote" & <tag> &quot; </script>';
      const escapedHtml = 'Edited [label] \\ &quot;quote&quot; &amp; &lt;tag&gt; &amp;quot; &lt;/script&gt;';
      const escapedMarkdown = String.raw`Edited \[label\] \\ "quote" \& \<tag\> \&quot; \</script\>`;
      for (const [value, references] of [
        [description, expected(escapedHtml, escapedMarkdown)],
        ["", expected(fallback)],
      ] as const) {
        const saved = await t.app.inject({
          method: "POST",
          url: `/assets/${asset.id}`,
          headers: {
            ...apiHost(), cookie: session.cookie, origin: ORIGIN,
            "content-type": "application/x-www-form-urlencoded", accept: "application/json",
          },
          payload: new URLSearchParams({ _csrf: session.csrf, description: `  ${value}  ` }).toString(),
        });
        assert.equal(saved.statusCode, 200, saved.body);
        const result = saved.json<{ description: string; altSource: string; snippets: Snippets }>();
        assert.equal(result.description, value);
        assert.equal(result.altSource, value || fallback);
        assert.deepEqual(result.snippets, references);
        assert.deepEqual(referenceSnippets(await page(`/assets/${asset.id}`)), references);
        const stored = await getAsset(t.db, asset.id);
        assert.ok(!("kind" in stored));
        assert.equal(stored.description, value || null);
      }
    });
  }

  it("preserves entity-like text in Markdown filename fallbacks", async () => {
    const asset = await apiUpload("AT&amp;T&#169;.png", "image/png", "pixels");
    assert.deepEqual(referenceSnippets(await page(`/assets/${asset.id}`)), {
      markdown: `![AT\\&amp;T\\&#169;](${asset.url})`,
      html: `<img src="${asset.url}" alt="AT&amp;amp;T&amp;#169;">`,
      curl: `curl -O ${asset.url}`,
    });
  });

  it("saves a description posted from the page, and deleting lands on the list with a notice", async () => {
    const asset = await apiUpload("notes.pdf", "application/pdf", "%PDF-1.4");
    const headers = {
      ...apiHost(),
      cookie: session.cookie,
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    };

    const saved = await t.app.inject({
      method: "POST",
      url: `/assets/${asset.id}`,
      headers,
      payload: new URLSearchParams({ _csrf: session.csrf, description: "  Reading list  " }).toString(),
    });
    assert.equal(saved.statusCode, 302);
    assert.equal(saved.headers.location, `/assets/${asset.id}`);
    assert.match(await page(`/assets/${asset.id}`), /<span class="desc-text" id="desc-text">Reading list<\/span>/);

    const cleared = await t.app.inject({
      method: "POST",
      url: `/assets/${asset.id}`,
      headers,
      payload: new URLSearchParams({ _csrf: session.csrf, description: "" }).toString(),
    });
    assert.equal(cleared.statusCode, 302);
    assert.match(
      await page(`/assets/${asset.id}`),
      /<span class="desc-text is-empty" id="desc-text">Add a description<\/span>/,
    );

    assert.doesNotMatch(await page(), /Asset deleted\./);
    const deleted = await t.app.inject({
      method: "POST",
      url: `/assets/${asset.id}/delete`,
      headers,
      payload: new URLSearchParams({ _csrf: session.csrf }).toString(),
    });
    assert.equal(deleted.statusCode, 302);
    assert.equal(deleted.headers.location, "/assets?deleted=1");
    const list = await page("/assets?deleted=1");
    assert.match(list, /<p class="flash" role="status">Asset deleted\.<\/p>/);
    assert.doesNotMatch(list, /notes\.pdf/);
  });

  describe("stepping between assets", () => {
    type Seeded = { id: string; filename: string | null };

    /** Four assets in a known order: two share a timestamp so the id tie-break is exercised. */
    async function seedFour(): Promise<{ newest: Seeded[]; byName: Record<string, Seeded> }> {
      await t.db.delete(assets);
      const oldest = await apiUpload("oldest.png", "image/png", "1");
      const middle = await apiUpload("fish & chips.png", "image/png", "2");
      const tieA = await apiUpload("tie-a.png", "image/png", "3");
      const tieB = await apiUpload("tie-b.png", "image/png", "4");
      const stamp = (iso: string) => ({ createdAt: new Date(iso) });
      await t.db.update(assets).set(stamp("2026-01-01T00:00:00.000Z")).where(eq(assets.id, oldest.id));
      await t.db.update(assets).set(stamp("2026-01-02T00:00:00.000Z")).where(eq(assets.id, middle.id));
      await t.db.update(assets).set(stamp("2026-01-03T00:00:00.000Z")).where(eq(assets.id, tieA.id));
      await t.db.update(assets).set(stamp("2026-01-03T00:00:00.000Z")).where(eq(assets.id, tieB.id));
      // Same timestamp: the larger id counts as newer, so it sits higher in the list.
      const tieHigh = tieA.id > tieB.id ? tieA : tieB;
      const tieLow = tieHigh === tieA ? tieB : tieA;
      return {
        newest: [tieHigh, tieLow, middle, oldest],
        byName: { oldest, middle, tieA, tieB },
      };
    }

    it("shows the position and links to the assets above and below in the list", async () => {
      const { newest } = await seedFour();
      const [first, second, third, last] = newest as [Seeded, Seeded, Seeded, Seeded];

      const mid = await page(`/assets/${second.id}`);
      assert.match(mid, /<div class="crumb-row has-pager">\s*<a class="back" href="\/assets">← Assets<\/a>/);
      assert.match(mid, /<nav class="crumb-pager" id="asset-pager" aria-label="Browse assets">/);
      assert.match(mid, /<span class="pager-count"><b>2<\/b> of 4<\/span>/);
      // Previous is the row above (newer), next the row below (older).
      assert.ok(
        mid.includes(`id="pager-prev" rel="prev" href="/assets/${first.id}" aria-label="Previous asset: ${first.filename}"`),
      );
      assert.ok(
        mid.includes(`id="pager-next" rel="next" href="/assets/${third.id}" aria-label="Next asset: ${third.filename?.replace("&", "&amp;")}"`),
      );
      assert.match(mid, /aria-keyshortcuts="ArrowLeft" title="Previous asset \(←\)"/);
      assert.match(mid, /aria-keyshortcuts="ArrowRight" title="Next asset \(→\)"/);
      assert.match(mid, /<span class="pager-hint" id="pager-hint" hidden>/, "the key hint stays hidden until the script decides to show it");
      assert.match(mid, /<p class="sr-only" id="pager-status" role="status" aria-live="polite"><\/p>/);

      const newestPage = await page(`/assets/${first.id}`);
      assert.match(newestPage, /<span class="pager-count"><b>1<\/b> of 4<\/span>/);
      assert.doesNotMatch(newestPage, /id="pager-prev"/, "the newest asset has nothing above it");
      assert.match(newestPage, /<span class="pager-btn is-disabled" id="pager-prev-end" aria-hidden="true" title="First asset">/);
      assert.ok(newestPage.includes(`id="pager-next" rel="next" href="/assets/${second.id}"`));

      const oldestPage = await page(`/assets/${last.id}`);
      assert.match(oldestPage, /<span class="pager-count"><b>4<\/b> of 4<\/span>/);
      assert.doesNotMatch(oldestPage, /id="pager-next"/, "the oldest asset has nothing below it");
      assert.match(oldestPage, /<span class="pager-btn is-disabled" id="pager-next-end" aria-hidden="true" title="Last asset">/);
      assert.ok(oldestPage.includes(`id="pager-prev" rel="prev" href="/assets/${third.id}"`));
    });

    it("follows the same newest-first order as the Assets list", async () => {
      const { newest } = await seedFour();
      const list = await page();
      const listed = [...list.matchAll(/<a class="asset-filename" href="\/assets\/([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(listed, newest.map((a) => a.id));

      // Walking "next" from the top visits every row once, in list order.
      const walked: string[] = [];
      let id: string | undefined = newest[0]?.id;
      while (id) {
        walked.push(id);
        const html = await page(`/assets/${id}`);
        id = html.match(/id="pager-next" rel="next" href="\/assets\/([^"]+)"/)?.[1];
      }
      assert.deepEqual(walked, listed);
    });

    it("breaks created_at ties by id and reports the position", async () => {
      const { newest } = await seedFour();
      const rows = await Promise.all(newest.map((a) => getAsset(t.db, a.id)));
      const records = rows as AssetRecord[];
      const seen = await Promise.all(records.map((r) => getAssetNeighbors(t.db, r)));
      assert.deepEqual(seen.map((n) => n.position), [1, 2, 3, 4]);
      assert.ok(seen.every((n) => n.total === 4));
      assert.deepEqual(seen.map((n) => n.previous?.id ?? null), [null, newest[0]?.id, newest[1]?.id, newest[2]?.id]);
      assert.deepEqual(seen.map((n) => n.next?.id ?? null), [newest[1]?.id, newest[2]?.id, newest[3]?.id, null]);
    });

    it("hides the pager when there is only one asset", async () => {
      const { newest } = await seedFour();
      const keep = newest[1];
      assert.ok(keep);
      await t.db.delete(assets).where(ne(assets.id, keep.id));

      const alone = await page(`/assets/${keep.id}`);
      assert.match(alone, /<div class="crumb-row">\s*<a class="back" href="\/assets">← Assets<\/a>\s*<\/div>/);
      assert.doesNotMatch(alone, /<nav class="crumb-pager"|id="pager-status"|class="pager-btn/);
    });
  });
});
