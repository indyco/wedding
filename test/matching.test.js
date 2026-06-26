"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { open } = require("../lib/db");
const { normalizeName, normalizeCode, lookupInvitee } = require("../lib/matching");

test("normalizeName strips diacritics, punctuation, case, and extra spaces", () => {
  assert.equal(normalizeName("  Renée  O'Brien-Smith! "), "renee o brien smith");
  assert.equal(normalizeName("JOSÉ   garcía"), "jose garcia");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(undefined), "");
});

test("normalizeCode trims and uppercases", () => {
  assert.equal(normalizeCode(" ab-12 "), "AB-12");
  assert.equal(normalizeCode(null), "");
});

test("lookup prefers the invite code and returns a unique match", () => {
  const s = open(":memory:");
  const alice = s.createInvitee({ name: "Alice Adams", invite_code: "alpha1", plus_ones_allotted: 1 });
  s.createInvitee({ name: "Bob Brown", invite_code: "beta2" });

  const r = lookupInvitee(s, { code: "ALPHA1", name: "totally wrong" });
  assert.equal(r.status, "unique");
  assert.equal(r.invitee.id, alice.id);
});

test("lookup falls back to name when the code is unknown", () => {
  const s = open(":memory:");
  const carol = s.createInvitee({ name: "Carol Clark" });
  const r = lookupInvitee(s, { code: "nope", name: "carol clark" });
  assert.equal(r.status, "unique");
  assert.equal(r.invitee.id, carol.id);
});

test("lookup returns 'multiple' for duplicate names", () => {
  const s = open(":memory:");
  s.createInvitee({ name: "John Smith", disambiguation_hint: "Oak St" });
  s.createInvitee({ name: "John Smith", disambiguation_hint: "Elm St" });

  const r = lookupInvitee(s, { name: "  john   smith " });
  assert.equal(r.status, "multiple");
  assert.equal(r.candidates.length, 2);
});

test("lookup returns 'none' when nothing matches", () => {
  const s = open(":memory:");
  s.createInvitee({ name: "Dave Davis" });
  assert.equal(lookupInvitee(s, { name: "nobody at all" }).status, "none");
  assert.equal(lookupInvitee(s, {}).status, "none");
});
