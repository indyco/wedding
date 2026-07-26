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

  let res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "Alice Adams", plus_ones_allotted: 1, invite_code: "1000000001" });
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
  await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "One", invite_code: "5555000001" });
  // Same digits, differently punctuated — must still collide after normalization.
  const res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "Two", invite_code: "5555-000001" });
  assert.equal(res.status, 409);
});

test("a non-numeric invitee id is a 404, not a 500", async () => {
  const { app } = setup();
  const agent = await loginAgent(app);

  for (const bad of ["abc", "1e9999", "0", "-3", "1.5"]) {
    const res = await agent.patch("/api/admin/invitees/" + bad).set(...CSRF).send({ name: "X" });
    assert.equal(res.status, 404, `PATCH ${bad}`);
    const del = await agent.delete("/api/admin/invitees/" + bad).set(...CSRF).send();
    assert.equal(del.status, 404, `DELETE ${bad}`);
    const rsvp = await agent.post(`/api/admin/invitees/${bad}/rsvp`).set(...CSRF).send({ attending: false });
    assert.equal(rsvp.status, 404, `RSVP ${bad}`);
  }
});

test("a short invite code is refused with a 400, not silently stored", async () => {
  const { store, app } = setup();
  const agent = await loginAgent(app);

  let res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "Short Sam", invite_code: "42" });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /exactly 10 digits/);
  assert.equal(store.listInvitees().length, 0);

  // Same door on the CSV side: the row is reported, not imported.
  const csv = "name,invite_code\nShort Sue,7\n";
  res = await agent.post("/api/admin/invitees/import").set(...CSRF).send({ csv });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 0);
  assert.equal(res.body.skipped, 1);
  assert.match(res.body.errors[0].error, /exactly 10 digits/);
  assert.equal(store.listInvitees().length, 0);
});

test("a mistyped invitee field is a 400, not a 500", async () => {
  const { store, app } = setup();
  const agent = await loginAgent(app);
  const inv = store.createInvitee({ name: "Edna Eastwood", invite_code: "1000000001" });

  // Exactly what the dashboard sends when the Name field is cleared and saved.
  let res = await agent.patch("/api/admin/invitees/" + inv.id).set(...CSRF).send({
    name: "", invite_code: "1000000001", plus_ones_allotted: "0", disambiguation_hint: "", email: "",
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Name is required/);
  assert.equal(store.getInvitee(inv.id).name, "Edna Eastwood", "the row must be left alone");

  res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "   " });
  assert.equal(res.status, 400);

  // A JSON body can carry any type; none of them may reach the bind layer.
  for (const body of [{ name: null }, { status: { a: 1 } }, { email: { a: 1 } }, { notes: ["a"] }, { plus_ones_allotted: "" }]) {
    res = await agent.patch("/api/admin/invitees/" + inv.id).set(...CSRF).send(body);
    assert.ok(res.status < 500, `PATCH ${JSON.stringify(body)} -> ${res.status}`);
  }
  // Clearing the stepper must not violate the NOT NULL column.
  assert.equal(store.getInvitee(inv.id).plus_ones_allotted, 0);
});

test("the +1 allotment is clamped, through every door", async () => {
  const { store, app } = setup();
  const agent = await loginAgent(app);

  let res = await agent.post("/api/admin/invitees").set(...CSRF).send({ name: "Big Bertha", plus_ones_allotted: "99999999999999999999" });
  assert.equal(res.status, 201);
  assert.equal(res.body.plus_ones_allotted, 20);

  res = await agent.patch("/api/admin/invitees/" + res.body.id).set(...CSRF).send({ plus_ones_allotted: 1e9 });
  assert.equal(res.body.plus_ones_allotted, 20);

  res = await agent.patch("/api/admin/invitees/" + res.body.id).set(...CSRF).send({ plus_ones_allotted: -5 });
  assert.equal(res.body.plus_ones_allotted, 0);

  // The CSV column can't be looser than the dashboard.
  await agent.post("/api/admin/invitees/import").set(...CSRF)
    .send({ csv: "name,plus_ones_allotted,invite_code\nCsv Carl,99999999999999999999,1000000009\n" });
  assert.equal(store.getInviteeByCode("1000000009").plus_ones_allotted, 20);
});

test("CSV import upserts, export returns rows", async () => {
  const { store, app } = setup();
  const agent = await loginAgent(app);

  const csv1 = "name,plus_ones_allotted,email,invite_code,notes\nAlice Adams,1,alice@example.com,1000000001,VIP\nBob Brown,0,,1000000002,\n";
  let res = await agent.post("/api/admin/invitees/import").set(...CSRF).send({ csv: csv1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.inserted, 2);
  assert.equal(res.body.updated, 0);

  // Re-import updates Alice (matched by invite code).
  const csv2 = "name,plus_ones_allotted,invite_code\nAlice Adams,3,1000000001\n";
  res = await agent.post("/api/admin/invitees/import").set(...CSRF).send({ csv: csv2 });
  assert.equal(res.body.inserted, 0);
  assert.equal(res.body.updated, 1);
  assert.equal(store.getInviteeByCode("1000000001").plus_ones_allotted, 3);

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
