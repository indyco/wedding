"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { open, generateInviteCode, INVITE_CODE_ALPHABET } = require("../lib/db");
const { normalizeName, normalizeCode, lookupInvitee } = require("../lib/matching");

const CODE_RE = new RegExp(`^[${INVITE_CODE_ALPHABET}]{8}$`);

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

test("generated invite codes avoid easily-misread characters", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateInviteCode();
    assert.match(code, CODE_RE);
    assert.equal(/[01ILOU]/.test(code), false, `ambiguous character in ${code}`);
  }
});

test("generated invite codes do not collide over many draws", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(generateInviteCode());
  assert.equal(seen.size, 2000);
});

test("every invitee gets a strong code, and lookup finds them by it", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Nora Nolan" });
  assert.match(inv.invite_code, CODE_RE);

  // Case-insensitive entry still matches.
  const r = lookupInvitee(s, { code: inv.invite_code.toLowerCase() });
  assert.equal(r.status, "unique");
  assert.equal(r.invitee.id, inv.id);
});

test("an admin-supplied invite code is kept as-is", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Owen Oakes", invite_code: "custom-1" });
  assert.equal(inv.invite_code, "CUSTOM-1");
});

test("clearing an invite code regenerates instead of blanking it", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Pia Park", invite_code: "WEAK1" });
  const updated = s.updateInvitee(inv.id, { invite_code: "" });
  assert.match(updated.invite_code, CODE_RE);
  assert.notEqual(updated.invite_code, "WEAK1");
});

test("generated invite codes avoid easily-misread characters", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateInviteCode();
    assert.match(code, CODE_RE);
    assert.equal(/[01ILOU]/.test(code), false, `ambiguous character in ${code}`);
  }
});

test("generated invite codes do not collide over many draws", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(generateInviteCode());
  assert.equal(seen.size, 2000);
});

test("every invitee gets a strong code, and lookup finds them by it", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Nora Nolan" });
  assert.match(inv.invite_code, CODE_RE);

  // Case-insensitive entry still matches.
  const r = lookupInvitee(s, { code: inv.invite_code.toLowerCase() });
  assert.equal(r.status, "unique");
  assert.equal(r.invitee.id, inv.id);
});

test("an admin-supplied invite code is kept as-is", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Owen Oakes", invite_code: "custom-1" });
  assert.equal(inv.invite_code, "CUSTOM-1");
});

test("clearing an invite code regenerates instead of blanking it", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Pia Park", invite_code: "WEAK1" });
  const updated = s.updateInvitee(inv.id, { invite_code: "" });
  assert.match(updated.invite_code, CODE_RE);
  assert.notEqual(updated.invite_code, "WEAK1");
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
