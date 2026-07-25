"use strict";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp, resolveSessionSecret } = require("../lib/app");

function appWithAdmin() {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  return createApp({ store, config: { sessionSecret: "test-secret" } });
}

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

/** The session ID out of a Set-Cookie header, or null. */
function sidFrom(res) {
  const raw = res.headers["set-cookie"];
  if (!raw) return null;
  const cookie = raw.find((c) => c.startsWith("wedding.sid="));
  return cookie ? cookie.split(";")[0].slice("wedding.sid=".length) : null;
}

test("login is rejected without the CSRF header", async () => {
  const app = appWithAdmin();
  const res = await request(app)
    .post("/api/admin/login")
    .send({ username: "admin", password: "password123" });
  assert.equal(res.status, 403);
});

test("login -> /api/me -> logout flow", async () => {
  const agent = request.agent(appWithAdmin());

  let res = await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "password123" });
  assert.equal(res.status, 200);

  res = await agent.get("/api/me");
  assert.equal(res.body.authenticated, true);
  assert.equal(res.body.username, "admin");

  res = await agent.post("/api/admin/logout").set(...CSRF).send();
  assert.equal(res.status, 200);

  res = await agent.get("/api/me");
  assert.equal(res.body.authenticated, false);
});

test("logging in issues a new session ID (no session fixation)", async () => {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  store.createInvitee({ name: "Fay Ford", invite_code: "F1" });
  const app = createApp({ store, config: { sessionSecret: "test-secret" } });
  const agent = request.agent(app);

  // Establish a pre-login session the way a guest would.
  const before = await agent.post("/api/lookup").set(...CSRF).send({ code: "F1" });
  const preLoginSid = sidFrom(before);
  assert.ok(preLoginSid, "expected a session cookie from the guest lookup");

  const login = await agent
    .post("/api/admin/login")
    .set(...CSRF)
    .send({ username: "admin", password: "password123" });
  assert.equal(login.status, 200);

  const postLoginSid = sidFrom(login);
  assert.ok(postLoginSid, "login must issue a new session cookie");
  assert.notEqual(postLoginSid, preLoginSid, "session ID must rotate on login");

  // The new session really is authenticated.
  assert.equal((await agent.get("/api/me")).body.authenticated, true);
});

test("the pre-login session is discarded, not upgraded", async () => {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  store.createInvitee({ name: "Fay Ford", invite_code: "F1" });
  const app = createApp({ store, config: { sessionSecret: "test-secret" } });

  // Attacker-held session: authorized for a guest RSVP, not for admin.
  const planted = request.agent(app);
  const plantedSid = sidFrom(await planted.post("/api/lookup").set(...CSRF).send({ code: "F1" }));
  assert.ok(plantedSid, "expected a session cookie to plant");

  // The victim logs in while carrying that exact session cookie.
  const login = await request(app)
    .post("/api/admin/login")
    .set(...CSRF)
    .set("Cookie", `wedding.sid=${plantedSid}`)
    .send({ username: "admin", password: "password123" });
  assert.equal(login.status, 200);
  assert.notEqual(sidFrom(login), plantedSid, "login must not keep the presented session ID");

  // The session the attacker holds must not have become an admin session.
  assert.equal((await planted.get("/api/me")).body.authenticated, false);
});

test("a guest RSVP authorization does not survive admin login", async () => {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  store.createInvitee({ name: "Fay Ford", invite_code: "F1" });
  const app = createApp({ store, config: { sessionSecret: "test-secret" } });
  const agent = request.agent(app);

  await agent.post("/api/lookup").set(...CSRF).send({ code: "F1" });
  await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "password123" });

  // rsvpInviteeId was dropped with the old session, so this is unauthorized.
  const res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "f@example.com", attendees: [{ name: "Fay Ford" }] });
  assert.equal(res.status, 403);
});

test("production refuses to start without a real SESSION_SECRET", () => {
  const good = "f".repeat(48);
  assert.equal(resolveSessionSecret({ secret: good, isProd: true }), good);

  assert.throws(() => resolveSessionSecret({ secret: "", isProd: true }), /must be set/);
  assert.throws(() => resolveSessionSecret({ secret: undefined, isProd: true }), /must be set/);
  assert.throws(
    () => resolveSessionSecret({ secret: "dev-insecure-secret-change-me", isProd: true }),
    /placeholder/
  );
  // The value shipped in .env.example is long enough to pass a length check.
  assert.throws(
    () => resolveSessionSecret({ secret: "change-me-to-a-long-random-string", isProd: true }),
    /placeholder/
  );
  assert.throws(() => resolveSessionSecret({ secret: "tooshort", isProd: true }), /at least 32/);
});

test("development tolerates a missing SESSION_SECRET", () => {
  assert.equal(typeof resolveSessionSecret({ secret: "", isProd: false }), "string");
  assert.equal(resolveSessionSecret({ secret: "t", isProd: false }), "t");
});

test("an unknown username costs the same as a wrong password", async () => {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });

  // Warm up, so first-call JIT effects don't land on whichever runs first.
  store.verifyAdmin("admin", "wrong");
  store.verifyAdmin("nobody", "wrong");

  const timeOf = (username) => {
    const runs = [];
    for (let i = 0; i < 12; i += 1) {
      const t0 = process.hrtime.bigint();
      assert.equal(store.verifyAdmin(username, "wrong-password"), null);
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]; // median resists scheduler noise
  };

  const knownUser = timeOf("admin");
  const unknownUser = timeOf("definitely-not-an-admin");

  // Without the decoy compare, the unknown-user path skips bcrypt entirely and
  // is orders of magnitude faster. Allow a wide band — this only has to catch
  // "no work done at all", not prove constant time.
  const ratio = knownUser / Math.max(unknownUser, 0.0001);
  assert.ok(
    ratio < 5,
    `unknown-username path is ${ratio.toFixed(1)}x faster (${unknownUser.toFixed(2)}ms vs ${knownUser.toFixed(2)}ms) — bcrypt work is being skipped`
  );
});

test("wrong password is rejected", async () => {
  const res = await request
    .agent(appWithAdmin())
    .post("/api/admin/login")
    .set(...CSRF)
    .send({ username: "admin", password: "nope" });
  assert.equal(res.status, 401);
});

test("change credentials updates username and password", async () => {
  const app = appWithAdmin();
  const agent = request.agent(app);
  await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "password123" });

  let res = await agent
    .post("/api/admin/change-credentials")
    .set(...CSRF)
    .send({ currentPassword: "password123", newUsername: "boss", newPassword: "newpassword1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.username, "boss");

  // New credentials should work on a fresh session.
  res = await request
    .agent(app)
    .post("/api/admin/login")
    .set(...CSRF)
    .send({ username: "boss", password: "newpassword1" });
  assert.equal(res.status, 200);
});

test("change credentials rejects a wrong current password", async () => {
  const agent = request.agent(appWithAdmin());
  await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "password123" });
  const res = await agent
    .post("/api/admin/change-credentials")
    .set(...CSRF)
    .send({ currentPassword: "WRONG", newPassword: "anotherpass1" });
  assert.equal(res.status, 401);
});
