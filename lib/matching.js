"use strict";

/**
 * Normalize a name for forgiving, case-insensitive matching.
 * trim -> strip diacritics -> lowercase -> drop punctuation -> collapse whitespace.
 */
function normalizeName(input) {
  return String(input == null ? "" : input)
    .normalize("NFKD") // split accented chars into base + combining mark
    .replace(/[\u0300-\u036f]/g, "") // remove the combining marks (diacritics)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .replace(/\s+/g, " ") // collapse runs of whitespace
    .trim();
}

/**
 * Canonicalize an invite code to digits only. Strips dashes, spaces, and any
 * other punctuation so "1234-5678", "1234 5678", and "12345678" all match.
 * Returns "" when there is no usable code.
 */
function normalizeCode(input) {
  return String(input == null ? "" : input).replace(/\D/g, "");
}

/**
 * Look up an invitee by invite code. Code is the ONLY lookup path — name-based
 * lookup was removed because it leaks the guest list (an enumeration oracle).
 *
 * `store` must provide getInviteeByCode(code) -> invitee | undefined.
 *
 * Returns one of:
 *   { status: "unique", invitee }
 *   { status: "none" }   (no match; caller responds generically)
 */
function lookupInvitee(store, { code } = {}) {
  const cleanCode = normalizeCode(code);
  if (cleanCode) {
    const byCode = store.getInviteeByCode(cleanCode);
    if (byCode) return { status: "unique", invitee: byCode };
  }
  return { status: "none" };
}

module.exports = { normalizeName, normalizeCode, lookupInvitee };
