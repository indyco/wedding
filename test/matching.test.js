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

test("normalizeCode trims and uppercases", () => {
  assert.equal(normalizeCode(" ab-12 "), "AB-12");
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
