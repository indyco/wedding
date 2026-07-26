"use strict";

/**
 * Invite-code generation and display formatting.
 *
 * Codes are 8 decimal digits drawn from a CSPRNG. `crypto.randomInt(0, max)`
 * is uniform over [0, max) — unlike `randomBytes() % n`, it has no modulo bias.
 * 10^8 space against ~150 guests is roughly 670k guesses per hit; digits-only
 * keeps `inputmode="numeric"` so guests get the large phone keypad.
 */

const crypto = require("crypto");

const CODE_DIGITS = 8;
const CODE_MAX = 10 ** CODE_DIGITS; // exclusive upper bound: 100,000,000

// A fresh random invite code as a zero-padded 8-digit string.
function generateInviteCode() {
  return String(crypto.randomInt(0, CODE_MAX)).padStart(CODE_DIGITS, "0");
}

// Format a canonical (digits-only) code for display: "1234-5678".
// Non-conforming values are returned as their bare digits (no crash).
function formatInviteCode(code) {
  const digits = String(code == null ? "" : code).replace(/\D/g, "");
  if (digits.length !== CODE_DIGITS) return digits;
  return digits.slice(0, 4) + "-" + digits.slice(4);
}

module.exports = { generateInviteCode, formatInviteCode, CODE_DIGITS };
