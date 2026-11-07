import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { apiTokens } from "../../src/db/schema.js";
import { seedBootstrapToken } from "../../src/services/tokens.js";
import {
  apiHost,
  auth,
  BOOTSTRAP_TOKEN,
  skipWithoutDb,
  startTestApp,
  type TestApp,
} from "../helpers/app.js";

const NEXT_TOKEN = "pp_rotated_bootstrap_token";
const NEXT_PEPPER = "pepper-after-rotation";

describe("bootstrap token reconcile", { skip: skipWithoutDb }, () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await startTestApp();
  });
  afterEach(async () => {
    await t?.close();
  });

  async function bootWith(pepper: string, bootstrapToken: string) {
    t.config.tokenPepper = pepper;
    t.config.bootstrapToken = bootstrapToken;
    await seedBootstrapToken({ db: t.db, pepper, bootstrapToken });
  }

  function me(token: string) {
    return t.app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { ...apiHost(), authorization: `Bearer ${token}` },
    });
  }

  async function mint(name: string) {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/tokens",
      headers: { ...apiHost(), ...auth },
      payload: { name },
    });
    assert.equal(created.statusCode, 201, created.body);
    return created.json<{ id: string; token: string }>();
  }

  async function row(id: string) {
    const [found] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
    assert.ok(found);
    return found;
  }

  async function bootstrapId() {
    const listed = await t.app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const item = listed.json<{ items: Array<{ id: string; name: string }> }>().items.find((entry) => entry.name === "bootstrap");
    assert.ok(item);
    return item.id;
  }

  it("rewrites the live bootstrap row when BOOTSTRAP_TOKEN changes and leaves other keys working", async () => {
    const user = await mint("editor");
    const before = await row(user.id);
    await bootWith(t.config.tokenPepper, NEXT_TOKEN);

    const accepted = await me(NEXT_TOKEN);
    assert.equal(accepted.statusCode, 200, accepted.body);
    const body = accepted.json<{ name: string; prefix: string }>();
    assert.equal(body.name, "bootstrap");
    assert.equal(body.prefix, NEXT_TOKEN.slice(0, 11));
    assert.equal((await me(BOOTSTRAP_TOKEN)).statusCode, 401);
    assert.equal((await me(user.token)).statusCode, 200);

    const after = await row(user.id);
    assert.equal(after.secretHash, before.secretHash);
    assert.equal(after.prefix, before.prefix);
    assert.equal(after.revokedAt, null);
  });

  it("rewrites the bootstrap row when TOKEN_PEPPER changes and leaves other rows stored as they were", async () => {
    const user = await mint("editor");
    const before = await row(user.id);
    const id = await bootstrapId();
    const bootstrapBefore = await row(id);
    await bootWith(NEXT_PEPPER, BOOTSTRAP_TOKEN);

    const accepted = await me(BOOTSTRAP_TOKEN);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json<{ prefix: string }>().prefix, BOOTSTRAP_TOKEN.slice(0, 11));

    const bootstrapAfter = await row(id);
    assert.notEqual(bootstrapAfter.secretHash, bootstrapBefore.secretHash);
    assert.equal(bootstrapAfter.prefix, bootstrapBefore.prefix);

    const after = await row(user.id);
    assert.equal(after.secretHash, before.secretHash);
    assert.equal(after.prefix, before.prefix);
    assert.equal(after.name, "editor");
    assert.equal((await me(user.token)).statusCode, 401);
  });

  it("inserts the bootstrap row when it is missing, even if other keys exist", async () => {
    const user = await mint("editor");
    await t.db.delete(apiTokens).where(eq(apiTokens.name, "bootstrap"));
    await bootWith(t.config.tokenPepper, BOOTSTRAP_TOKEN);

    assert.equal((await me(BOOTSTRAP_TOKEN)).statusCode, 200);
    assert.equal((await me(user.token)).statusCode, 200);
    const listed = await t.app.inject({
      method: "GET",
      url: "/api/v1/tokens",
      headers: { ...apiHost(), ...auth },
    });
    const names = listed.json<{ items: Array<{ name: string }> }>().items.map((entry) => entry.name);
    assert.deepEqual(names.filter((name) => name === "bootstrap"), ["bootstrap"]);
  });

  it("leaves a revoked bootstrap row revoked", async () => {
    const id = await bootstrapId();
    const revoked = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/tokens/${id}`,
      headers: { ...apiHost(), ...auth },
    });
    assert.equal(revoked.statusCode, 204, revoked.body);
    const before = await row(id);

    await bootWith(NEXT_PEPPER, NEXT_TOKEN);

    const after = await row(id);
    assert.equal(after.secretHash, before.secretHash);
    assert.equal(after.prefix, before.prefix);
    assert.ok(after.revokedAt);
    assert.equal((await me(NEXT_TOKEN)).statusCode, 401);
    assert.equal((await me(BOOTSTRAP_TOKEN)).statusCode, 401);

    await assert.doesNotReject(() =>
      seedBootstrapToken({ db: t.db, pepper: NEXT_PEPPER, bootstrapToken: "nope" }),
    );
    const still = await row(id);
    assert.equal(still.secretHash, before.secretHash);
    assert.ok(still.revokedAt);
  });

  it("rejects a bootstrap token that does not start with pp_ and leaves the live row in place", async () => {
    const id = await bootstrapId();
    const before = await row(id);
    await assert.rejects(
      () => seedBootstrapToken({ db: t.db, pepper: t.config.tokenPepper, bootstrapToken: "not-a-token" }),
      /BOOTSTRAP_TOKEN must start with pp_/,
    );
    const after = await row(id);
    assert.equal(after.secretHash, before.secretHash);
    assert.equal((await me(BOOTSTRAP_TOKEN)).statusCode, 200);
  });
});
