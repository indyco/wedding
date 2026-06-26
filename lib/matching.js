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
 * Normalize an invite code: trim + uppercase so matching is case-insensitive.
 * Returns "" when there is no usable code.
 */
function normalizeCode(input) {
  return String(input == null ? "" : input).trim().toUpperCase();
}

/**
 * Look up an invitee by invite code (preferred) or by name.
 *
 * `store` must provide:
 *   - getInviteeByCode(code)            -> invitee | undefined
 *   - findInviteesByNormalizedName(norm)-> invitee[]
 *
 * Returns one of:
 *   { status: "unique",   invitee }
 *   { status: "multiple", candidates }  (duplicate names; ask for code/hint)
 *   { status: "none" }                  (no match; caller responds generically)
 */
function lookupInvitee(store, { code, name } = {}) {
  const cleanCode = normalizeCode(code);
  if (cleanCode) {
    const byCode = store.getInviteeByCode(cleanCode);
    if (byCode) return { status: "unique", invitee: byCode };
    // Code provided but not found: fall through to name (if any) before giving up.
  }

  const norm = normalizeName(name);
  if (norm) {
    const matches = store.findInviteesByNormalizedName(norm);
    if (matches.length === 1) return { status: "unique", invitee: matches[0] };
    if (matches.length > 1) return { status: "multiple", candidates: matches };
  }

  return { status: "none" };
}

module.exports = { normalizeName, normalizeCode, lookupInvitee };
