"use strict";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp } = require("../lib/app");

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

function setup() {
  const store = open(":memory:");
  store.bootstrapAdmin({ username: "admin", password: "password123" });
  const app = createApp({ store, config: { sessionSecret: "t" } });
  return { store, app };
}

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "password123" });
  return agent;
}

test("admin endpoints require authentication", async () => {
  const { app } = setup();
  const res = await request(app).get("/api/admin/invitees");
  assert.equal(res.status, 401);
});

test("invitee create / list / patch / delete", async () => {
  const { app } = setup();
  const agent = await loginAgent(app);

  let res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "Alice Adams", plus_ones_allotted: 1, invite_code: "A1" });
  assert.equal(res.status, 201);
  const id = res.body.id;

  res = await agent.get("/api/admin/invitees");
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);

  res = await agent.patch("/api/admin/invitees/" + id).set(...CSRF).send({ plus_ones_allotted: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.plus_ones_allotted, 3);

  res = await agent.delete("/api/admin/invitees/" + id).set(...CSRF).send();
  assert.equal(res.status, 200);

  res = await agent.get("/api/admin/invitees");
  assert.equal(res.body.length, 0);
});

test("duplicate invite code is rejected", async () => {
  const { app } = setup();
  const agent = await loginAgent(app);
  await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "One", invite_code: "DUP" });
  const res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "Two", invite_code: "dup" });
  assert.equal(res.status, 409);
});

test("CSV import upserts, export returns rows", async () => {
  const { store, app } = setup();
  const agent = await loginAgent(app);

  const csv1 = "name,plus_ones_allotted,email,invite_code,notes\nAlice Adams,1,alice@example.com,A1,VIP\nBob Brown,0,,B2,\n";
  let res = await agent.post("/api/admin/invitees/import").set(...CSRF).send({ csv: csv1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 2);
  assert.equal(res.body.updated, 0);

  // Re-import updates Alice (matched by invite code).
  const csv2 = "name,plus_ones_allotted,invite_code\nAlice Adams,3,A1\n";
  res = await agent.post("/api/admin/invitees/import").set(...CSRF).send({ csv: csv2 });
  assert.equal(res.body.inserted, 0);
  assert.equal(res.body.updated, 1);
  assert.equal(store.getInviteeByCode("A1").plus_ones_allotted, 3);

  res = await agent.get("/api/admin/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/csv/);
  assert.match(res.text, /Alice Adams/);
  assert.match(res.text, /Bob Brown/);
});

test("summary headcounts and rsvps filter", async () => {
  const { store, app } = setup();
  const a = store.createInvitee({ name: "Yes Yvonne", plus_ones_allotted: 1 });
  const b = store.createInvitee({ name: "No Nate" });
  store.createInvitee({ name: "Pending Pat" });
  store.saveRsvp({ inviteeId: a.id, attending: true, email: "y@x.com", attendees: [{ name: "Yvonne" }, { name: "Guest" }] });
  store.saveRsvp({ inviteeId: b.id, attending: false, email: "n@x.com" });

  const agent = await loginAgent(app);

  let res = await agent.get("/api/admin/summary");
  assert.equal(res.body.invited, 3);
  assert.equal(res.body.responded, 2);
  assert.equal(res.body.pending, 1);
  assert.equal(res.body.headcount, 2);

  res = await agent.get("/api/admin/rsvps?filter=yes");
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "Yes Yvonne");

  res = await agent.get("/api/admin/rsvps?filter=pending");
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "Pending Pat");
});
