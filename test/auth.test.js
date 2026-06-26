"use strict";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp } = require("../lib/app");

function appWithAdmin() {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  return createApp({ store, config: { sessionSecret: "test-secret" } });
}

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

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
