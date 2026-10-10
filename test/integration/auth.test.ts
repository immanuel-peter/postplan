import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { apiHost, auth, skipWithoutDb, startTestApp, type TestApp } from "../helpers/app.js";

describe("api token auth", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t?.close();
  });

  function listDrafts(headers: Record<string, string>) {
    return t.app.inject({ method: "GET", url: "/api/v1/drafts", headers: { ...apiHost(), ...headers } });
  }

  it("rejects missing, malformed, and unknown tokens", async () => {
    assert.equal((await listDrafts({})).statusCode, 401);
    assert.equal((await listDrafts({ authorization: "Basic abc" })).statusCode, 401);
    assert.equal((await listDrafts({ authorization: "Bearer pp_not_a_real_token" })).statusCode, 401);
    const res = await listDrafts({});
    assert.match(String(res.headers["content-type"]), /application\/problem\+json/);
  });

  it("accepts the seeded bootstrap token", async () => {
    assert.equal((await listDrafts(auth)).statusCode, 200);
  });

  it("creates tokens that work and stop working once revoked", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...apiHost(), ...auth },
      payload: { name: "ci" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json<{ id: string; token: string; prefix: string }>();
    assert.match(body.token, /^pp_/);
    assert.equal(body.prefix, body.token.slice(0, 11));

    const bearer = { authorization: `Bearer ${body.token}` };
    assert.equal((await listDrafts(bearer)).statusCode, 200);

    const listed = await t.app.inject({ method: "GET", url: "/api/v1/tokens", headers: { ...apiHost(), ...auth } });
    const items = listed.json<{ items: Array<Record<string, unknown>> }>().items;
    assert.ok(items.some((item) => item.id === body.id));
    assert.ok(items.every((item) => !("token" in item)), "secrets are never listed");

    const revoked = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${body.id}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(revoked.statusCode, 204);
    assert.equal((await listDrafts(bearer)).statusCode, 401);
  });

  it("rejects expired tokens", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...apiHost(), ...auth },
      payload: { name: "short-lived", expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    assert.equal(created.statusCode, 201, created.body);
    const token = created.json<{ token: string }>().token;
    assert.equal((await listDrafts({ authorization: `Bearer ${token}` })).statusCode, 401);
  });

  it("serves the OpenAPI document with the core routes", async () => {
    const res = await t.app.inject({ method: "GET", url: "/openapi.json", headers: apiHost() });
    assert.equal(res.statusCode, 200);
    const spec = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    assert.equal(spec.openapi, "3.1.0");
    for (const path of [
      "/api/v1/drafts",
      "/api/v1/drafts/{id}",
      "/api/v1/drafts/{id}/versions",
      "/api/v1/assets",
      "/api/v1/tokens",
    ]) {
      assert.ok(path in spec.paths, `missing ${path}`);
    }
  });

  it("answers health checks on any host, including rejected ones", async () => {
    const health = await t.app.inject({ method: "GET", url: "/healthz", headers: { host: "whatever.example" } });
    assert.equal(health.statusCode, 200);
    const ready = await t.app.inject({ method: "GET", url: "/readyz", headers: apiHost() });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json<{ postgres: string }>().postgres, "ok");

    const foreign = await t.app.inject({ method: "GET", url: "/", headers: { host: "example.com" } });
    assert.equal(foreign.statusCode, 404);
  });
});
