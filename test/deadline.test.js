"use strict";

/**
 * RSVP_DEADLINE bounds how long an emailed edit link stays usable, and closes
 * the guest-facing surface once it passes. Also covers edit-token rotation when
 * the contact address on an RSVP changes.
 */

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp, parseDeadline } = require("../lib/app");

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

function setup(rsvpDeadline) {
  const store = open(":memory:");
  const sent = [];
  const sendEmail = async (m) => {
    sent.push(m);
    return { id: "fake-" + sent.length };
  };
  const app = createApp({
    store,
    sendEmail,
    config: { sessionSecret: "t", appBaseUrl: "https://wed.example", rsvpDeadline, warn: () => {} },
  });
  return { store, app, sent };
}

const PAST = "2000-01-01";
const FUTURE = "2999-01-01";

test("parseDeadline treats a bare date as the end of that day, UTC", () => {
  assert.equal(parseDeadline("2026-09-01").toISOString(), "2026-09-01T23:59:59.999Z");
  assert.equal(parseDeadline("2026-09-01T12:00:00Z").toISOString(), "2026-09-01T12:00:00.000Z");
});

test("parseDeadline treats blank as no deadline and rejects garbage", () => {
  assert.equal(parseDeadline(""), null);
  assert.equal(parseDeadline(undefined), null);
  assert.throws(() => parseDeadline("next tuesday"), /Invalid RSVP_DEADLINE/);
});

test("before the deadline everything still works", async () => {
  const { store, app } = setup(FUTURE);
  store.createInvitee({ name: "Ada Ames", invite_code: "1000000001" });
  const agent = request.agent(app);

  let res = await agent.post("/api/lookup").set(...CSRF).send({ code: "1000000001" });
  assert.equal(res.status, 200);
  assert.equal(res.body.match, "unique");

  res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "ada@example.com", attendees: [{ name: "Ada Ames" }] });
  assert.equal(res.status, 200);
});

test("after the deadline lookup and submission are closed", async () => {
  const { store, app } = setup(PAST);
  store.createInvitee({ name: "Ada Ames", invite_code: "1000000001" });
  const agent = request.agent(app);

  let res = await agent.post("/api/lookup").set(...CSRF).send({ code: "1000000001" });
  assert.equal(res.status, 403);
  assert.equal(res.body.closed, true);

  res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "ada@example.com", attendees: [{ name: "Ada Ames" }] });
  assert.equal(res.status, 403);
  assert.equal(res.body.closed, true);
});

test("after the deadline a previously-valid edit link stops working", async () => {
  // Submit while open, then re-open the same store with the deadline passed.
  const store = open(":memory:");
  store.createInvitee({ name: "Ben Boyd", invite_code: "1000000002" });

  const openApp = createApp({
    store,
    sendEmail: async () => ({ id: "x" }),
    config: { sessionSecret: "t", rsvpDeadline: FUTURE },
  });
  const agent = request.agent(openApp);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "1000000002" });
  const res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "ben@example.com", attendees: [{ name: "Ben Boyd" }] });
  const token = res.body.edit_token;
  assert.ok(token);

  // Same data, deadline now past.
  const closedApp = createApp({
    store,
    sendEmail: async () => ({ id: "x" }),
    config: { sessionSecret: "t", rsvpDeadline: PAST },
  });
  const after = await request(closedApp).get("/api/rsvp?token=" + token);
  assert.equal(after.status, 410);
  assert.equal(after.body.closed, true);
});

test("with no deadline configured nothing expires", async () => {
  const { store, app } = setup(undefined);
  store.createInvitee({ name: "Cara Cole", invite_code: "1000000003" });
  const agent = request.agent(app);

  const res = await agent.post("/api/lookup").set(...CSRF).send({ code: "1000000003" });
  assert.equal(res.status, 200);
});

test("changing the address rotates the token and warns the old address", async () => {
  const { store, app, sent } = setup(FUTURE);
  const inv = store.createInvitee({ name: "Dana Dunn", invite_code: "1000000004" });
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "1000000004" });

  let res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "dana@example.com", attendees: [{ name: "Dana Dunn" }] });
  const firstToken = res.body.edit_token;
  // First submission is not a change — only the confirmation goes out.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "dana@example.com");

  res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "attacker@example.test", attendees: [{ name: "Dana Dunn" }] });
  assert.equal(res.status, 200);
  const secondToken = res.body.edit_token;

  assert.notEqual(secondToken, firstToken, "token must rotate when the address changes");

  // The old link is dead; the new one works.
  assert.equal((await request(app).get("/api/rsvp?token=" + firstToken)).status, 404);
  assert.equal((await request(app).get("/api/rsvp?token=" + secondToken)).status, 200);

  // The previous address was warned, and that warning carries no edit link.
  const warning = sent.find((m) => m.to === "dana@example.com" && /was changed/i.test(m.subject));
  assert.ok(warning, "expected a warning to the previous address");
  assert.equal(/\/\?edit=/.test(warning.text), false, "warning must not leak an edit link");
  assert.match(warning.text, /attacker@example\.test/);

  assert.equal(store.getRsvpByInviteeId(inv.id).email, "attacker@example.test");
});

test("re-saving with the same address does not rotate the token", async () => {
  const { store, app, sent } = setup(FUTURE);
  store.createInvitee({ name: "Erik Ek", invite_code: "1000000005" });
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "1000000005" });

  let res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "erik@example.com", attendees: [{ name: "Erik Ek" }] });
  const first = res.body.edit_token;

  res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "ERIK@example.com", message: "one more", attendees: [{ name: "Erik Ek" }] });
  assert.equal(res.body.edit_token, first, "same address (any case) must keep the token");
  assert.equal(sent.filter((m) => /was changed/i.test(m.subject)).length, 0);
});
