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

test("normalizeCode reduces to digits only", () => {
  assert.equal(normalizeCode(" 1234-5678 "), "12345678");
  assert.equal(normalizeCode("1234 5678"), "12345678");
  assert.equal(normalizeCode("abc"), ""); // no digits
  assert.equal(normalizeCode(null), "");
});

test("lookup matches by invite code (dashes/spaces ignored)", () => {
  const s = open(":memory:");
  const alice = s.createInvitee({ name: "Alice Adams", invite_code: "31415926", plus_ones_allotted: 1 });
  s.createInvitee({ name: "Bob Brown", invite_code: "27182818" });

  const r = lookupInvitee(s, { code: "3141-5926" });
  assert.equal(r.status, "unique");
  assert.equal(r.invitee.id, alice.id);
});

test("lookup by name is no longer supported (enumeration oracle removed)", () => {
  const s = open(":memory:");
  s.createInvitee({ name: "Carol Clark", invite_code: "40000001" });
  // A name — even an exact one — must never resolve to an invitee.
  assert.equal(lookupInvitee(s, { name: "carol clark" }).status, "none");
});

test("lookup returns 'none' when the code is unknown or absent", () => {
  const s = open(":memory:");
  s.createInvitee({ name: "Dave Davis", invite_code: "40000002" });
  assert.equal(lookupInvitee(s, { code: "99999999" }).status, "none");
  assert.equal(lookupInvitee(s, {}).status, "none");
});
