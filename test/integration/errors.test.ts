import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ERROR_PAGE_CSP } from "../../src/lib/errors.js";
import { authenticateSession, createSession } from "../../src/services/admin.js";
import {
  apiHost,
  assetsHost,
  auth,
  draftHost,
  htmlDoc,
  multipart,
  skipWithoutDb,
  startTestApp,
  type TestApp,
} from "../helpers/app.js";

const SESSION_COOKIE = "__Host-postplan_session";
const THEME_COOKIE = "__Host-postplan_theme";
const BROWSER = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  retryable: boolean;
};

function h1(body: string): string | undefined {
  return /<h1>([^<]*)<\/h1>/.exec(body)?.[1];
}

function connectionRefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:3900"), { code: "ECONNREFUSED" });
}

describe("error pages and problem+json", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
  });
  afterEach(() => {
    if (t) {
      t.s3.failWith = null;
    }
  });
  after(async () => {
    await t?.close();
  });

  async function publish(html: string) {
    const form = multipart([{ name: "html", filename: "page.html", contentType: "text/html", data: html }]);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: { ...apiHost(), ...auth, ...form.headers },
      payload: form.payload,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<{ id: string; slug: string }>();
  }

  function assertPage(res: Awaited<ReturnType<TestApp["app"]["inject"]>>, status: number, title: string) {
    assert.equal(res.statusCode, status, res.body);
    assert.match(res.headers["content-type"] ?? "", /^text\/html/);
    assert.equal(res.headers["content-security-policy"], ERROR_PAGE_CSP);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(String(res.headers["x-request-id"]), /^req_[0-9A-Z]{26}$/);
    assert.equal(h1(res.body), title);
    assert.match(res.body, new RegExp(`<title>${status} `));
  }

  it("serves the 404 page for unknown slugs and stray paths on Draft hosts", async () => {
    const unknown = await t.app.inject({ method: "GET", url: "/", headers: { ...draftHost("nosuchslug"), ...BROWSER } });
    assertPage(unknown, 404, "Oops, nothing is published here");
    assert.match(unknown.body, /<span class="host">nosuchslug\.postplan\.test<\/span>/);
    assert.doesNotMatch(unknown.body, /Try again/, "a 404 does not offer a retry");

    const plainCurl = await t.app.inject({ method: "GET", url: "/nope", headers: draftHost("nosuchslug") });
    assertPage(plainCurl, 404, "Oops, nothing is published here");
  });

  it("serves 410 for a deleted Draft, on the root, a version, and the card", async () => {
    const draft = await publish(htmlDoc("soon gone"));
    const deleted = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/drafts/${draft.id}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(deleted.statusCode, 204);
    for (const url of ["/", "/v/1"]) {
      const res = await t.app.inject({ method: "GET", url, headers: { ...draftHost(draft.slug), ...BROWSER } });
      assertPage(res, 410, "Oops, this Draft was taken down");
    }
    const card = await t.app.inject({ method: "GET", url: "/og.png", headers: draftHost(draft.slug) });
    assert.equal(card.statusCode, 410);
  });

  it("turns a storage crash into the 500 page, and never leaks the exception", async () => {
    const draft = await publish(htmlDoc("fine until storage breaks"));
    t.s3.failWith = new Error("secret internal detail: bucket key xyz");

    const page = await t.app.inject({ method: "GET", url: "/", headers: { ...draftHost(draft.slug), ...BROWSER } });
    assertPage(page, 500, "Oops, something broke on our end");
    assert.match(page.body, /<a class="btn btn-primary" href="">Try again<\/a>/);
    assert.doesNotMatch(page.body, /secret internal detail/);
    assert.equal(page.headers.etag, undefined, "the ETag set for the expected page is dropped");

    const json = await t.app.inject({
      method: "GET",
      url: "/v/1?x=1",
      headers: { ...draftHost(draft.slug), accept: "application/json" },
    });
    assert.equal(json.statusCode, 500);
    assert.match(json.headers["content-type"] ?? "", /^application\/problem\+json/);
    const body = json.json<ProblemBody>();
    assert.deepEqual(body, {
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "Postplan hit an unexpected error. It has been logged, and retrying usually works.",
      instance: "/v/1",
      requestId: json.headers["x-request-id"],
      retryable: true,
    });
  });

  it("answers 503 with Retry-After when storage is unreachable", async () => {
    const draft = await publish(htmlDoc("storage down"));
    t.s3.failWith = connectionRefused();

    const page = await t.app.inject({ method: "GET", url: "/", headers: { ...draftHost(draft.slug), ...BROWSER } });
    assertPage(page, 503, "Oops, Postplan is briefly unavailable");
    assert.equal(page.headers["retry-after"], "30");

    const form = multipart([{ name: "html", filename: "page.html", contentType: "text/html", data: htmlDoc("x") }]);
    const api = await t.app.inject({
      method: "POST",
      url: "/api/v1/drafts",
      headers: { ...apiHost(), ...auth, ...form.headers, accept: "text/html" },
      payload: form.payload,
    });
    assert.equal(api.statusCode, 503, "the API always answers in JSON, whatever Accept says");
    assert.match(api.headers["content-type"] ?? "", /^application\/problem\+json/);
    const body = api.json<ProblemBody>();
    assert.equal(body.title, "Service Unavailable");
    assert.equal(body.retryable, true);
    assert.equal(body.instance, "/api/v1/drafts");
    assert.doesNotMatch(api.body, /ECONNREFUSED|10\.0\.0\.9/);
  });

  it("enriches every API problem with instance, requestId, and retryable", async () => {
    const missing = await t.app.inject({
      method: "GET",
      url: "/api/v1/drafts/does-not-exist",
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(missing.statusCode, 404);
    const body = missing.json<ProblemBody>();
    assert.equal(body.instance, "/api/v1/drafts/does-not-exist");
    assert.equal(body.requestId, missing.headers["x-request-id"]);
    assert.equal(body.retryable, false);

    const route = await t.app.inject({ method: "GET", url: "/api/v1/nope", headers: { ...apiHost(), ...auth } });
    assert.equal(route.statusCode, 404);
    assert.match(route.headers["content-type"] ?? "", /^application\/problem\+json/);
    assert.equal(route.json<ProblemBody>().detail, "Nothing is served at this path.");

    const badJson = await t.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...apiHost(), ...auth, "content-type": "application/json" },
      payload: "{not json",
    });
    assert.equal(badJson.statusCode, 400);
    const bad = badJson.json<ProblemBody>();
    assert.equal(bad.title, "Bad Request");
    assert.equal(bad.retryable, false);
  });

  it("ignores a client-sent request id", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/nope",
      headers: { ...apiHost(), "request-id": "<script>", "x-request-id": "forged" },
    });
    assert.match(String(res.headers["x-request-id"]), /^req_[0-9A-Z]{26}$/);
  });

  it("serves the asset host's 404 page", async () => {
    const res = await t.app.inject({ method: "GET", url: "/nope", headers: { ...assetsHost(), ...BROWSER } });
    assertPage(res, 404, "Oops, there is no file here");
  });

  it("serves the dashboard 404 page in the saved theme, with a link home", async () => {
    const { token } = await createSession({ db: t.db, pepper: t.config.tokenPepper, userAgent: "test" });
    assert.ok(await authenticateSession({ db: t.db, pepper: t.config.tokenPepper, token }));
    const cookie = `${SESSION_COOKIE}=${token}; ${THEME_COOKIE}=dark`;

    for (const url of ["/no-such-page", "/drafts/no-such-draft"]) {
      const res = await t.app.inject({ method: "GET", url, headers: { ...apiHost(), ...BROWSER, cookie } });
      assertPage(res, 404, "Oops, this page doesn’t exist");
      assert.match(res.body, /<html lang="en" data-theme="dark">/);
      assert.match(res.body, /<a class="brand" href="\/">/);
    }
  });
});
