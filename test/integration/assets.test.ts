import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  apiHost,
  assetsHost,
  auth,
  multipart,
  skipWithoutDb,
  startTestApp,
  type TestApp,
} from "../helpers/app.js";

type AssetBody = {
  id: string;
  url: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  filename: string | null;
  description: string | null;
};

describe("assets", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t?.close();
  });

  async function upload(filename: string, contentType: string, data: Buffer | string, description?: string) {
    const form = multipart([
      { name: "file", filename, contentType, data },
      ...(description === undefined ? [] : [{ name: "description", value: description }]),
    ]);
    return t.app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...apiHost(), ...auth, ...form.headers },
      payload: form.payload,
    });
  }

  it("uploads, serves publicly with CORS, supports ranges, and deletes", async () => {
    const bytes = Buffer.from("0123456789");
    const created = await upload("digits.txt", "text/plain", bytes, "  some digits ");
    assert.equal(created.statusCode, 201, created.body);
    const asset = created.json<AssetBody>();
    assert.equal(asset.byteSize, 10);
    assert.equal(asset.description, "some digits");
    assert.equal(asset.url, `https://assets.postplan.test/${asset.id}.txt`);

    const path = `/${asset.id}.txt`;
    const served = await t.app.inject({ method: "GET", url: path, headers: assetsHost() });
    assert.equal(served.statusCode, 200);
    assert.equal(served.body, "0123456789");
    assert.equal(served.headers["access-control-allow-origin"], "*");
    assert.equal(served.headers["x-content-type-options"], "nosniff");
    assert.equal(served.headers.etag, `"${asset.sha256}"`);
    assert.equal(served.headers["content-disposition"], 'inline; filename="digits.txt"');

    const download = await t.app.inject({ method: "GET", url: `${path}?download=1`, headers: assetsHost() });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "0123456789");
    assert.equal(download.headers["content-disposition"], 'attachment; filename="digits.txt"');

    const notModified = await t.app.inject({
      method: "GET",
      url: path,
      headers: { ...assetsHost(), "if-none-match": `"${asset.sha256}"` },
    });
    assert.equal(notModified.statusCode, 304);

    const ranged = await t.app.inject({ method: "GET", url: path, headers: { ...assetsHost(), range: "bytes=2-4" } });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.body, "234");
    assert.equal(ranged.headers["content-range"], "bytes 2-4/10");

    const rangedDownload = await t.app.inject({
      method: "GET",
      url: `${path}?download=1`,
      headers: { ...assetsHost(), range: "bytes=2-4" },
    });
    assert.equal(rangedDownload.statusCode, 206);
    assert.equal(rangedDownload.body, "234");
    assert.equal(rangedDownload.headers["content-range"], "bytes 2-4/10");
    assert.equal(rangedDownload.headers["content-disposition"], 'attachment; filename="digits.txt"');

    const suffix = await t.app.inject({ method: "GET", url: path, headers: { ...assetsHost(), range: "bytes=-3" } });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.body, "789");

    const bad = await t.app.inject({ method: "GET", url: path, headers: { ...assetsHost(), range: "bytes=50-" } });
    assert.equal(bad.statusCode, 416);
    assert.equal(bad.headers["content-range"], "bytes */10");

    const deleted = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/assets/${asset.id}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(deleted.statusCode, 204);
    const gone = await t.app.inject({ method: "GET", url: path, headers: assetsHost() });
    assert.equal(gone.statusCode, 404);
  });

  it("infers common file types from generic uploads and serves the stored type", async () => {
    for (const [filename, expectedType] of [
      ["clip.mp4", "video/mp4"],
      ["sound.mp3", "audio/mpeg"],
      ["data.csv", "text/csv"],
      ["unknown.bin", "application/octet-stream"],
    ] as const) {
      const bytes = Buffer.from(`content for ${filename}`);
      const created = await upload(filename, "application/octet-stream", bytes);
      assert.equal(created.statusCode, 201, created.body);
      const asset = created.json<AssetBody>();
      assert.equal(asset.contentType, expectedType, filename);

      const read = await t.app.inject({
        method: "GET", url: `/api/v1/assets/${asset.id}`, headers: { ...apiHost(), ...auth },
      });
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json<AssetBody>().contentType, expectedType, filename);

      const served = await t.app.inject({
        method: "GET", url: new URL(asset.url).pathname, headers: assetsHost(),
      });
      assert.equal(served.statusCode, 200);
      assert.equal(served.headers["content-type"], expectedType, filename);
      assert.deepEqual(served.rawPayload, bytes);
      assert.equal(served.headers["x-content-type-options"], "nosniff");
    }
  });

  it("refuses HTML and JavaScript by type or extension", async () => {
    for (const [name, type] of [
      ["page.html", "text/html"],
      ["page.html", "application/octet-stream"],
      ["page.txt", "text/html; charset=utf-8"],
      ["script.js", "text/plain"],
      ["module.mjs", "application/octet-stream"],
      ["app.bin", "application/javascript"],
    ] as const) {
      const res = await upload(name, type, "alert(1)");
      assert.equal(res.statusCode, 400, `${name} as ${type}`);
    }
  });

  it("requires a file", async () => {
    const form = multipart([{ name: "description", value: "no file" }]);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/assets",
      headers: { ...apiHost(), ...auth, ...form.headers },
      payload: form.payload,
    });
    assert.equal(res.statusCode, 400);
  });

  it("patches the description", async () => {
    const asset = (await upload("a.png", "image/png", Buffer.from([0x89, 0x50]))).json<AssetBody>();
    const patched = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${asset.id}`,
      headers: { ...apiHost(), ...auth },
      payload: { description: "a tiny png" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json<AssetBody>().description, "a tiny png");

    const cleared = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/assets/${asset.id}`,
      headers: { ...apiHost(), ...auth },
      payload: { description: null },
    });
    assert.equal(cleared.json<AssetBody>().description, null);
  });

  it("encodes non-ASCII filenames in Content-Disposition", async () => {
    const asset = (await upload("résumé.pdf", "application/pdf", Buffer.from("%PDF-1.4"))).json<AssetBody>();
    const served = await t.app.inject({ method: "GET", url: `/${asset.id}.pdf`, headers: assetsHost() });
    assert.equal(
      served.headers["content-disposition"],
      "inline; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
    const download = await t.app.inject({ method: "GET", url: `/${asset.id}.pdf?download=1`, headers: assetsHost() });
    assert.equal(
      download.headers["content-disposition"],
      "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
  });

  it("404s unknown ids and other paths on the assets host", async () => {
    for (const url of ["/NOPE", "/NOPE.png", "/a/b/c"]) {
      const res = await t.app.inject({ method: "GET", url, headers: assetsHost() });
      assert.equal(res.statusCode, 404, url);
    }
  });

  it("filters the asset list with q", async () => {
    async function make(name: string, data: string, description?: string) {
      const res = await upload(name, "text/plain", data, description);
      assert.equal(res.statusCode, 201, res.body);
      return res.json<AssetBody>();
    }
    const chart = await make("chart.png", "png", "quarterly numbers");
    const notes = await make("notes.txt", "txt");
    const archive = await make("archive.zip", "zip", "100% packed");
    const underscore = await make("foo_bar.txt", "ub");
    const wild = await make("fooxbar.txt", "wild");

    const ids = async (q: string) => {
      const res = await t.app.inject({
        method: "GET",
        url: `/api/v1/assets?limit=100&q=${encodeURIComponent(q)}`,
        headers: { ...apiHost(), ...auth },
      });
      assert.equal(res.statusCode, 200, res.body);
      return new Set(res.json<{ items: AssetBody[] }>().items.map((item) => item.id));
    };

    assert.deepEqual(await ids("chart"), new Set([chart.id]), "filename is searched");
    assert.deepEqual(await ids("QUARTERLY"), new Set([chart.id]), "case-insensitive");
    assert.deepEqual(await ids("quarterly numbers"), new Set([chart.id]), "words may match different columns");
    assert.deepEqual(await ids("quarterly packed"), new Set(), "every word must match");
    assert.deepEqual(await ids("100%"), new Set([archive.id]), "% is a literal");
    assert.deepEqual(await ids("foo_bar"), new Set([underscore.id]), "_ is a literal");

    const noFilter = await t.app.inject({
      method: "GET",
      url: "/api/v1/assets?limit=100&q=",
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(noFilter.statusCode, 200, noFilter.body);
    const all = new Set(noFilter.json<{ items: AssetBody[] }>().items.map((item) => item.id));
    for (const asset of [chart, notes, archive, underscore, wild]) {
      assert.ok(all.has(asset.id));
    }

    for (let i = 1; i <= 3; i += 1) {
      const res = await upload(`alpha-${i}.txt`, "text/plain", `alpha ${i}`);
      assert.equal(res.statusCode, 201, res.body);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = await t.app.inject({
        method: "GET",
        url: `/api/v1/assets?limit=2&q=${encodeURIComponent("alpha")}${query}`,
        headers: { ...apiHost(), ...auth },
      });
      assert.equal(page.statusCode, 200, page.body);
      const body = page.json<{ items: AssetBody[]; nextCursor: string | null }>();
      for (const item of body.items) {
        assert.ok(!seen.has(item.id), "pages must not overlap");
        assert.match(item.filename ?? "", /^alpha-/, "only matching assets are listed");
        seen.add(item.id);
      }
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    assert.equal(seen.size, 3);
    assert.equal(pages, 2);
  });
});
