"use strict";

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp } = require("../lib/app");
const { generateInviteCode, formatInviteCode } = require("../lib/codes");
const { normalizeCode, lookupInvitee } = require("../lib/matching");
const { exportCatererCsv } = require("../lib/csv");

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
  await agent.post("/api/lookup").set(...CSRF).send({ code: "C2" });
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

// --- Priority 1: correctness of the RSVP update path -----------------------

test("1.1 absent field leaves the stored value unchanged; empty string clears it", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Ida Iverson", plus_ones_allotted: 1, invite_code: "I1" });
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "i1" });

  // Attending RSVP with an email + message on file.
  let res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "ida@example.com", message: "so excited", attendees: [{ name: "Ida" }] });
  assert.equal(res.status, 200);

  const token = store.getRsvpByInviteeId(inv.id).edit_token;

  // Edit to decline WITHOUT resending email/message — absent must NOT clobber.
  res = await agent.post("/api/rsvp").set(...CSRF).send({ editToken: token, attending: false });
  assert.equal(res.status, 200);
  let stored = store.getRsvpByInviteeId(inv.id);
  assert.equal(stored.attending, 0);
  assert.equal(stored.email, "ida@example.com", "absent email should be preserved");
  assert.equal(stored.message, "so excited", "absent message should be preserved");

  // Now explicitly clear the message with an empty string.
  res = await agent.post("/api/rsvp").set(...CSRF).send({ editToken: token, attending: false, message: "" });
  assert.equal(res.status, 200);
  stored = store.getRsvpByInviteeId(inv.id);
  assert.equal(stored.message, null, "empty string should clear the message");
  assert.equal(stored.email, "ida@example.com", "email still untouched");
});

test("1.2 dropping an attendee (2 -> 1) removes the row and updates headcount", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Hank House", plus_ones_allotted: 1, invite_code: "H1" });
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "h1" });

  let res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "hank@example.com", attendees: [{ name: "Hank" }, { name: "Helen", dietary: "veg" }] });
  assert.equal(res.status, 200);
  assert.equal(store.getRsvpByInviteeId(inv.id).attendees.length, 2);
  assert.equal(store.getSummary().headcount, 2);

  const token = store.getRsvpByInviteeId(inv.id).edit_token;

  // Re-submit with a single attendee: the dropped row must be gone, not stale.
  res = await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ editToken: token, attending: true, email: "hank@example.com", attendees: [{ name: "Hank" }] });
  assert.equal(res.status, 200);
  const stored = store.getRsvpByInviteeId(inv.id);
  assert.equal(stored.attendees.length, 1);
  assert.equal(stored.attendees[0].name, "Hank");
  assert.equal(store.getSummary().headcount, 1, "headcount reflects the removed attendee");
});

test("1.3 yes -> no -> yes: attendees clear on decline and are restored from the resent list", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Gus Grove", plus_ones_allotted: 1, invite_code: "G1" });
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code: "g1" });

  // Yes, with a dietary note.
  await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ attending: true, email: "gus@example.com", attendees: [{ name: "Gus", dietary: "gluten-free" }] });
  const token = store.getRsvpByInviteeId(inv.id).edit_token;
  assert.equal(store.getRsvpByInviteeId(inv.id).attendees.length, 1);

  // No: declining clears the attendee rows (documented behavior).
  await agent.post("/api/rsvp").set(...CSRF).send({ editToken: token, attending: false });
  assert.equal(store.getRsvpByInviteeId(inv.id).attendees.length, 0);
  assert.equal(store.getSummary().headcount, 0);
  assert.equal(store.getRsvpByInviteeId(inv.id).email, "gus@example.com", "email survives the decline");

  // Yes again with the resent list: attendees + dietary come back intact.
  await agent
    .post("/api/rsvp")
    .set(...CSRF)
    .send({ editToken: token, attending: true, email: "gus@example.com", attendees: [{ name: "Gus", dietary: "gluten-free" }] });
  const restored = store.getRsvpByInviteeId(inv.id);
  assert.equal(restored.attendees.length, 1);
  assert.equal(restored.attendees[0].dietary, "gluten-free");
  assert.equal(store.getSummary().headcount, 1);
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

// --- Priority 2: invite codes ----------------------------------------------

test("2. generated codes are 8 digits; format is dashed; normalize strips punctuation", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateInviteCode();
    assert.match(code, /^\d{8}$/, "code must be exactly 8 digits");
  }
  assert.equal(formatInviteCode("12345678"), "1234-5678");
  assert.equal(normalizeCode("1234-5678"), "12345678");
  assert.equal(normalizeCode("  1234 5678 "), "12345678");
  assert.equal(normalizeCode("ABC"), "");
});

test("2. new invitees are auto-assigned a unique 8-digit code when none is given", () => {
  const store = open(":memory:");
  const a = store.createInvitee({ name: "No Code One" });
  const b = store.createInvitee({ name: "No Code Two" });
  assert.match(a.invite_code, /^\d{8}$/);
  assert.match(b.invite_code, /^\d{8}$/);
  assert.notEqual(a.invite_code, b.invite_code);
});

// --- Priority 3: code is the only lookup path ------------------------------

test("3. name-only lookup no longer matches anyone", async () => {
  const { store, app } = setup();
  store.createInvitee({ name: "Nadia Nowak", plus_ones_allotted: 1, invite_code: "12121212" });
  const res = await request.agent(app).post("/api/lookup").set(...CSRF).send({ name: "nadia nowak" });
  assert.equal(res.status, 200);
  assert.equal(res.body.match, "none", "name must not resolve to an invitee");

  // lookupInvitee ignores name entirely.
  assert.equal(lookupInvitee(store, { name: "nadia nowak" }).status, "none");
  assert.equal(lookupInvitee(store, { code: "1212-1212" }).status, "unique");
});

test("3. admin can RSVP on a guest's behalf", async () => {
  const { store, app } = setup();
  store.bootstrapAdmin({ username: "admin", password: "pw12345" });
  const inv = store.createInvitee({ name: "Lost Card Larry", plus_ones_allotted: 1 });

  const agent = request.agent(app);
  let res = await agent.post("/api/admin/login").set(...CSRF).send({ username: "admin", password: "pw12345" });
  assert.equal(res.status, 200);

  res = await agent
    .post("/api/admin/invitees/" + inv.id + "/rsvp")
    .set(...CSRF)
    .send({ attending: true, attendees: [{ name: "Larry", dietary: "no nuts" }, { name: "Linda" }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.attendees.length, 2);

  const stored = store.getRsvpByInviteeId(inv.id);
  assert.equal(stored.attending, 1);
  assert.equal(stored.attendees.length, 2);
  assert.equal(stored.attendees[0].dietary, "no nuts");
  assert.equal(store.getInvitee(inv.id).status, "responded");
});

test("3. on-behalf RSVP requires an admin session", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Guarded Guest" });
  const res = await request
    .agent(app)
    .post("/api/admin/invitees/" + inv.id + "/rsvp")
    .set(...CSRF)
    .send({ attending: false });
  assert.equal(res.status, 401);
});

// --- Priority 4: caterer export is minimized -------------------------------

test("4. caterer export has dietary + headcount only, no PII", async () => {
  const { store } = setup();
  const a = store.createInvitee({ name: "Party A", plus_ones_allotted: 2, invite_code: "20000001" });
  store.saveRsvp({
    inviteeId: a.id,
    attending: true,
    email: "a@example.com",
    attendees: [
      { name: "Ann", dietary: "Vegetarian", is_primary: true },
      { name: "Al", dietary: "Vegetarian" },
      { name: "Amy", dietary: "" },
    ],
  });

  const csv = exportCatererCsv(store);
  assert.match(csv, /dietary,headcount/);
  assert.match(csv, /Vegetarian,2/);
  assert.match(csv, /No restriction,1/);
  assert.match(csv, /TOTAL,3/);
  // No personal data leaks into the caterer file.
  assert.doesNotMatch(csv, /a@example\.com/);
  assert.doesNotMatch(csv, /Ann|Amy|Party A/);
  assert.doesNotMatch(csv, /20000001/);
});
