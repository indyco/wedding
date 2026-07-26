"use strict";

/**
 * Invite-code generation and display formatting.
 *
 * Codes are 10 decimal digits drawn from a CSPRNG. `crypto.randomInt(0, max)`
 * is uniform over [0, max) — unlike `randomBytes() % n`, it has no modulo bias.
 * A 10^10 space against ~150 guests is roughly 67 million guesses per hit; at
 * the 30/min the public rate limiter allows, that is far out of reach. Keeping
 * codes digits-only lets the guest form use `inputmode="numeric"`, so phones
 * show the large keypad.
 *
 * The code is the ONLY thing authenticating a guest (name lookup was removed
 * because it leaked the guest list), so its entropy is load-bearing — don't
 * shorten it.
 */

const crypto = require("crypto");

const CODE_DIGITS = 10;
const CODE_MAX = 10 ** CODE_DIGITS; // exclusive upper bound: 10,000,000,000

// A fresh random invite code as a zero-padded 10-digit string.
function generateInviteCode() {
  return String(crypto.randomInt(0, CODE_MAX)).padStart(CODE_DIGITS, "0");
}

/**
 * Is this a canonical invite code — exactly CODE_DIGITS decimal digits?
 *
 * Generated codes always are. This exists for the codes a human supplies: the
 * dashboard's Code field and the `invite_code` column of a CSV import. A short
 * code like "42" would still be accepted by the lookup route, and since the code
 * is the only thing authenticating a guest, it would be brute-forceable inside
 * the public rate limit. Callers must validate before storing.
 */
function isValidInviteCode(code) {
  return new RegExp(`^\\d{${CODE_DIGITS}}$`).test(String(code == null ? "" : code));
}

/**
 * Format a canonical (digits-only) code for display, split into two halves:
 * "12345-67890". Non-conforming values are returned as their bare digits.
 */
function formatInviteCode(code) {
  const digits = String(code == null ? "" : code).replace(/\D/g, "");
  if (digits.length !== CODE_DIGITS) return digits;
  const half = Math.ceil(CODE_DIGITS / 2);
  return digits.slice(0, half) + "-" + digits.slice(half);
}

module.exports = { generateInviteCode, isValidInviteCode, formatInviteCode, CODE_DIGITS };
