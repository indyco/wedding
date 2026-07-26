"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { open } = require("../lib/db");
const { generateInviteCode, formatInviteCode, CODE_DIGITS } = require("../lib/codes");
const { normalizeName, normalizeCode, lookupInvitee } = require("../lib/matching");

const CODE_RE = new RegExp(`^[0-9]{${CODE_DIGITS}}$`);

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

test("generated invite codes are the full configured length", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.match(generateInviteCode(), CODE_RE);
  }
});

test("generated invite codes do not collide over many draws", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(generateInviteCode());
  assert.equal(seen.size, 2000);
});

test("the code space is large enough that guessing is impractical", () => {
  // Guards against someone shortening CODE_DIGITS: at ~150 guests this is the
  // expected number of guesses per hit, and the public limiter allows 30/min.
  const guessesPerHit = 10 ** CODE_DIGITS / 150;
  assert.ok(guessesPerHit > 1e7, `only ${guessesPerHit.toExponential(1)} guesses per hit`);
});

test("formatInviteCode splits a canonical code in half", () => {
  const code = generateInviteCode();
  const half = Math.ceil(CODE_DIGITS / 2);
  assert.equal(formatInviteCode(code), code.slice(0, half) + "-" + code.slice(half));
  // Anything not canonical comes back as bare digits, without throwing.
  assert.equal(formatInviteCode("12-34"), "1234");
  assert.equal(formatInviteCode(null), "");
});

test("every invitee gets a code, and lookup finds them by it", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Nora Nolan" });
  assert.match(inv.invite_code, CODE_RE);

  // Dashed entry, as printed on the invitation, still matches.
  const r = lookupInvitee(s, { code: formatInviteCode(inv.invite_code) });
  assert.equal(r.status, "unique");
  assert.equal(r.invitee.id, inv.id);
});

test("an admin-supplied code is canonicalized to its digits", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Owen Oakes", invite_code: "1234-500-001" });
  assert.equal(inv.invite_code, "1234500001");
});

test("a supplied code with no digits mints a fresh one instead of blanking", () => {
  const s = open(":memory:");
  const a = s.createInvitee({ name: "Pia Park", invite_code: "ABC" });
  const b = s.createInvitee({ name: "Quinn Quest", invite_code: "XYZ" });
  // Both must get real codes — not "", which would collide on the UNIQUE index.
  assert.match(a.invite_code, CODE_RE);
  assert.match(b.invite_code, CODE_RE);
  assert.notEqual(a.invite_code, b.invite_code);
});

test("clearing an invite code regenerates instead of blanking it", () => {
  const s = open(":memory:");
  const inv = s.createInvitee({ name: "Rex Reed", invite_code: "5000000001" });
  const updated = s.updateInvitee(inv.id, { invite_code: "" });
  assert.match(updated.invite_code, CODE_RE);
  assert.notEqual(updated.invite_code, "5000000001");
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
