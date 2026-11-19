import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, ctx, next) {
    return specifier === "cloudflare:sockets"
      ? {
          url: 'data:text/javascript,export function connect(){throw Error("Live transport requires Cloudflare")}',
          shortCircuit: true,
        }
      : next(specifier, ctx);
  },
});
const worker = (await import("./src/index.js")).default;
import { charge, parseHeader } from "./src/wire.js";
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(
  readFileSync(new URL("./schema/0001_initial.sql", import.meta.url), "utf8"),
);
const db = {
  prepare(q) {
    const stmt = sqlite.prepare(q);
    function bound(...args) {
      return {
        bind: bound,
        first: () => stmt.get(...args),
        all: () => ({ results: stmt.all(...args) }),
        run: () => ({ meta: stmt.run(...args) }),
      };
    }
    return bound();
  },
  batch(stmts) {
    sqlite.exec("BEGIN");
    try {
      const r = stmts.map((s) => s.run());
      sqlite.exec("COMMIT");
      return r;
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  },
};
const env = {
  DB: db,
  BOOTSTRAP_SECRET: "local-test-only",
  ALLOWED_ORIGINS: "https://zerynxit.github.io",
};
const mf = {
  dispatchFetch: (url, opt) => worker.fetch(new Request(url, opt), env),
  dispose: () => sqlite.close(),
};
try {
  const health = await mf.dispatchFetch("https://test.example/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json().then((v) => ({
    ok: v.ok,
    service: v.service,
    database: v.database,
  })), {
    ok: true,
    service: "ZERYNX VPN API",
    database: "connected",
  });
  const missingDB = await worker.fetch(
    new Request("https://test.example/api/health"),
    {},
  );
  assert.equal(missingDB.status, 503);
  assert.equal((await missingDB.json()).database, "not_configured");

  // Static assets must still be served when D1 is not configured.
  const assetEnv = {
    ASSETS: {
      fetch: async (request) =>
        new Response("asset:" + new URL(request.url).pathname),
    },
  };
  const assetRoot = await worker.fetch(
    new Request("https://test.example/"),
    assetEnv,
  );
  assert.equal(assetRoot.status, 200);
  assert.equal(await assetRoot.text(), "asset:/");
  const assetFile = await worker.fetch(
    new Request("https://test.example/assets/js/app.js"),
    assetEnv,
  );
  assert.equal(assetFile.status, 200);
  assert.equal(await assetFile.text(), "asset:/assets/js/app.js");

  assert.equal(
    (await mf.dispatchFetch("https://test.example/stream")).status,
    426,
  );

  let token = "";
  const api = (p, d) =>
    mf.dispatchFetch("https://test.example" + p, {
      method: d ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: d ? JSON.stringify(d) : undefined,
    });
  assert.equal((await api("/api/users")).status, 401);
  const owner = {
    username: "admin",
    password: "a-local-test-password",
    setupKey: "local-test-only",
  };
  const setupRace = await Promise.all([
    api("/api/setup", owner),
    api("/api/setup", owner),
  ]);
  assert.deepEqual(setupRace.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (await api("/api/setup", { ...owner, note: "x".repeat(12000) })).status,
    413,
  );
  token = (await (await api("/api/auth/login", owner)).json()).token;
  assert.ok(token);
  const { link } = await (
    await api("/api/users", { username: "test-user", days: 2, gb: 0.001 })
  ).json();
  const sub = new URL(link).pathname;
  const result = await api(sub);
  const config = atob(await result.text());
  assert.match(config, /^vless:.*type=ws/);
  const configUrl = new URL(config);
  assert.equal(configUrl.protocol, "vless:");
  assert.equal(configUrl.port, "443");
  assert.equal(configUrl.searchParams.get("security"), "tls");
  assert.equal(configUrl.searchParams.get("path"), "/stream");
  const {
    users: [u],
  } = await (await api("/api/users")).json();
  const test = await Promise.allSettled([
    charge(db, u.id, 700000),
    charge(db, u.id, 700000),
  ]);
  assert.equal(test.filter((r) => r.status === "fulfilled").length, 1);
  await charge(db, u.id, 300000);
  await assert.rejects(charge(db, u.id, 1));
  assert.equal((await api(sub)).status, 403);
  await api("/api/users/" + u.id + "/rotate", {});
  assert.equal((await api(sub)).status, 404);
  await db
    .prepare("UPDATE users SET used_bytes=0,expires_at=? WHERE id=?")
    .bind(new Date(0).toISOString(), u.id)
    .run();
  await assert.rejects(charge(db, u.id, 1));
  await db
    .prepare("UPDATE users SET expires_at=? WHERE id=?")
    .bind(new Date(Date.now() + 60000).toISOString(), u.id)
    .run();
  await api("/api/users/" + u.id + "/toggle", {});
  await assert.rejects(charge(db, u.id, 1));
  assert.equal(
    (
      await api("/api/credentials", {
        ...owner,
        current: owner.password,
        password: "new-local-password",
      })
    ).status,
    200,
  );
  assert.equal((await api("/api/users")).status, 401);
  const frame = Uint8Array.of(
    0,
    ...new Uint8Array(16),
    0,
    1,
    1,
    187,
    2,
    11,
    ...new TextEncoder().encode("example.com"),
  );
  assert.equal(parseHeader(frame).host, "example.com");
  assert.equal(parseHeader(frame.slice(0, 20)), null);
  frame[18] = 2;
  assert.throws(() => parseHeader(frame));
  console.log(
    "PASS: owner setup/login, authorization, creation, subscription format, concurrent quota, exhaustion, expiry, suspension, link rotation, credential change, session invalidation and VLESS header checks.",
  );
} finally {
  await mf.dispose();
}
