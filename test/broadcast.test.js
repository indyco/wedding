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
  const sent = [];
  const failOn = new Set();
  const sendEmail = async (m) => {
    if (failOn.has(m.to)) throw new Error("boom");
    sent.push(m);
    return { id: "x" + (sent.length) };
  };
  const app = createApp({ store, sendEmail, config: { sessionSecret: "t" } });
  return { store, app, sent, failOn };
}

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "password123" });
  return agent;
}

test("broadcast targets only unique attending emails", async () => {
  const { store, app, sent } = setup();
  const a = store.createInvitee({ name: "A", plus_ones_allotted: 1 });
  const b = store.createInvitee({ name: "B" });
  const c = store.createInvitee({ name: "C" });
  const d = store.createInvitee({ name: "D" });
  const e = store.createInvitee({ name: "E" });
  store.saveRsvp({ inviteeId: a.id, attending: true, email: "a@x.com", attendees: [{ name: "A" }] });
  store.saveRsvp({ inviteeId: b.id, attending: true, email: "b@x.com", attendees: [{ name: "B" }] });
  store.saveRsvp({ inviteeId: c.id, attending: true, email: "A@x.com", attendees: [{ name: "C" }] }); // dup (case-insensitive)
  store.saveRsvp({ inviteeId: d.id, attending: false, email: "d@x.com" }); // declined -> excluded
  store.saveRsvp({ inviteeId: e.id, attending: true, email: "", attendees: [{ name: "E" }] }); // no email -> excluded

  const agent = await loginAgent(app);
  const res = await agent.post("/api/admin/broadcast").set(...CSRF).send({ subject: "See you!", body: "Details inside" });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.sent, 2);
  assert.equal(res.body.failed, 0);
  assert.equal(sent.length, 2);
});

test("broadcast records per-recipient failures in the email log", async () => {
  const { store, app, failOn } = setup();
  const a = store.createInvitee({ name: "A" });
  const b = store.createInvitee({ name: "B" });
  store.saveRsvp({ inviteeId: a.id, attending: true, email: "a@x.com", attendees: [{ name: "A" }] });
  store.saveRsvp({ inviteeId: b.id, attending: true, email: "b@x.com", attendees: [{ name: "B" }] });
  failOn.add("b@x.com");

  const agent = await loginAgent(app);
  const res = await agent.post("/api/admin/broadcast").set(...CSRF).send({ subject: "Hi", body: "x" });
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.failed, 1);

  const log = await agent.get("/api/admin/email-log");
  const statuses = log.body.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["failed", "sent"]);
});

test("test-send delivers to the chosen address", async () => {
  const { app, sent } = setup();
  const agent = await loginAgent(app);
  const res = await agent
    .post("/api/admin/broadcast/test")
    .set(...CSRF)
    .send({ subject: "T", body: "B", to: "me@x.com" });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "me@x.com");
});

test("broadcast requires subject and body", async () => {
  const { app } = setup();
  const agent = await loginAgent(app);
  const res = await agent.post("/api/admin/broadcast").set(...CSRF).send({ subject: "only subject" });
  assert.equal(res.status, 400);
});
