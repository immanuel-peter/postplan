import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyRequest } from "fastify";
import {
  errorStatus,
  isDependencyUnavailable,
  pageTitle,
  renderErrorPage,
  wantsHtml,
} from "../../src/lib/errors.js";
import { isRetryableStatus } from "../../src/lib/problems.js";

function req(url: string, accept?: string): FastifyRequest {
  return { url, headers: accept === undefined ? {} : { accept } } as unknown as FastifyRequest;
}

describe("errorStatus", () => {
  it("keeps 4xx/5xx status codes and maps everything else to 500", () => {
    assert.equal(errorStatus(Object.assign(new Error("x"), { statusCode: 413 })), 413);
    assert.equal(errorStatus(Object.assign(new Error("x"), { statusCode: 302 })), 500);
    assert.equal(errorStatus(new Error("boom")), 500);
    assert.equal(errorStatus("not even an error"), 500);
  });

  it("maps unreachable dependencies to 503, including wrapped and aggregated causes", () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    assert.equal(errorStatus(refused), 503);
    assert.equal(errorStatus(new Error("outer", { cause: refused })), 503);
    assert.equal(errorStatus(Object.assign(new AggregateError([refused]), {})), 503);
    assert.equal(errorStatus(Object.assign(new Error("slow"), { name: "TimeoutError" })), 503);
    assert.equal(errorStatus(Object.assign(new Error("s3"), { $metadata: { httpStatusCode: 503 } })), 503);
    assert.equal(errorStatus(Object.assign(new Error("pg"), { code: "CONNECT_TIMEOUT" })), 503);
  });

  it("does not treat an S3 4xx or a missing key as an outage", () => {
    assert.equal(isDependencyUnavailable(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" })), false);
    assert.equal(isDependencyUnavailable(Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } })), false);
  });
});

describe("wantsHtml", () => {
  it("never sends HTML for the API", () => {
    assert.equal(wantsHtml(req("/api/v1/drafts", "text/html")), false);
    assert.equal(wantsHtml(req("/openapi.json", "text/html")), false);
  });

  it("sends HTML to browsers and curl, JSON to clients that ask for it", () => {
    assert.equal(wantsHtml(req("/", "text/html,application/xhtml+xml,*/*;q=0.8")), true);
    assert.equal(wantsHtml(req("/", "*/*")), true);
    assert.equal(wantsHtml(req("/")), true);
    assert.equal(wantsHtml(req("/v/1", "application/json")), false);
    assert.equal(wantsHtml(req("/v/1", "application/problem+json")), false);
  });
});

describe("renderErrorPage", () => {
  const base = { surface: "draft" as const, host: "fern.postplan.link", requestId: "req_1", theme: "system" as const };

  it("offers Try again only when a retry can help", () => {
    assert.match(renderErrorPage({ ...base, status: 500 }), />Try again</);
    assert.match(renderErrorPage({ ...base, status: 503 }), />Try again</);
    assert.doesNotMatch(renderErrorPage({ ...base, status: 404 }), />Try again</);
    assert.doesNotMatch(renderErrorPage({ ...base, status: 410 }), />Try again</);
  });

  it("hides Go back until script finds history", () => {
    assert.match(renderErrorPage({ ...base, status: 404 }), /<button type="button" class="btn btn-secondary" id="back" hidden>Go back<\/button>/);
  });

  it("escapes the host", () => {
    const html = renderErrorPage({ ...base, status: 404, host: '<img src=x onerror="alert(1)">' });
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });

  it("pins the theme only when one is saved", () => {
    assert.match(renderErrorPage({ ...base, status: 500, theme: "dark" }), /<html lang="en" data-theme="dark">/);
    assert.match(renderErrorPage({ ...base, status: 500 }), /<html lang="en">/);
  });

  it("titles each status for its host", () => {
    assert.equal(pageTitle(500, "draft"), "Oops, something broke on our end");
    assert.equal(pageTitle(502, "draft"), "Oops, something broke on our end");
    assert.equal(pageTitle(503, "dashboard"), "Oops, Postplan is briefly unavailable");
    assert.equal(pageTitle(404, "draft"), "Oops, nothing is published here");
    assert.equal(pageTitle(404, "assets"), "Oops, there is no file here");
    assert.equal(pageTitle(410, "draft"), "Oops, this Draft was taken down");
    assert.equal(pageTitle(400, "dashboard"), "Oops, that request didn’t work");
  });
});

describe("isRetryableStatus", () => {
  it("is true for transient failures only", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryableStatus(status), true, String(status));
    }
    for (const status of [400, 401, 403, 404, 409, 410, 413, 501]) {
      assert.equal(isRetryableStatus(status), false, String(status));
    }
  });
});
