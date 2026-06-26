"use strict";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp } = require("../lib/app");

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

function setup() {
  const store = open(":memory:");
  const sent = [];
  const sendEmail = async (m) => {
    sent.push(m);
    return { id: "fake-" + sent.length };
  };
  const app = createApp({
    store,
    sendEmail,
    config: { sessionSecret: "t", appBaseUrl: "https://wed.example" },
  });
  return { store, app, sent };
}

test("lookup by code, then submit attending within allotment", async () => {
  const { store, app, sent } = setup();
  const inv = store.createInvitee({ name: "Alice Adams", plus_ones_allotted: 1, invite_code: "A1" });
  const agent = request.agent(app);

  let res = await agent.post("/api/lookup").set(...CSRF).send({ code: "a1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.match, "unique");
  assert.equal(res.body.invitee.plus_ones_allotted, 1);

  res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "alice@example.com", message: "yay", attendees: [{ name: "Alice" }, { name: "Bob", dietary: "veg" }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.attendees.length, 2);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/\?edit=/);

  const full = store.getRsvpByInviteeId(inv.id);
  assert.equal(full.attending, 1);
  assert.equal(full.attendees.length, 2);
  assert.equal(store.getInvitee(inv.id).status, "responded");
});

test("exceeding the allotment is rejected", async () => {
  const { store, app } = setup();
  store.createInvitee({ name: "Solo Sam", plus_ones_allotted: 0, invite_code: "S0" });
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "s0" });

  const res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "s@x.com", attendees: [{ name: "Sam" }, { name: "Plus One" }] });
  assert.equal(res.status, 400);
});

test("submitting without a prior lookup is forbidden", async () => {
  const { app } = setup();
  const res = await request.agent(app).post("/api/rsvp").set(...CSRF).send({ attending: false });
  assert.equal(res.status, 403);
});

test("decline, then edit via the email token", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Carol Clark", plus_ones_allotted: 2, invite_code: "C2" });

  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ name: "carol clark" });
  let res = await agent.post("/api/rsvp").set(...CSRF).send({ attending: false, email: "carol@example.com" });
  assert.equal(res.status, 200);
  assert.equal(res.body.attending, false);

  const token = store.getRsvpByInviteeId(inv.id).edit_token;

  // A fresh session (no prior lookup) can load + edit via the token.
  const fresh = request.agent(app);
  res = await fresh.get("/api/rsvp?token=" + token);
  assert.equal(res.status, 200);
  assert.equal(res.body.rsvp.attending, false);

  res = await fresh
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ editToken: token, attending: true, email: "carol@example.com", attendees: [{ name: "Carol" }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.attending, true);
  assert.equal(store.getRsvpByInviteeId(inv.id).attending, 1);
});

test("the honeypot field is silently ignored", async () => {
  const { store, app } = setup();
  store.createInvitee({ name: "Dave Davis", invite_code: "D1" });
  const res = await request
    .agent(app)
    .post("/api/lookup")
    .set(...CSRF)
    .send({ code: "d1", company: "spam-bot" });
  assert.equal(res.status, 200);
  assert.equal(res.body.match, "none");
});
