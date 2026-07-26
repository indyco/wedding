"use strict";

/**
 * Shared normalization for free-text fields that guests or admins type in.
 *
 * Both write paths must use these — the public RSVP form and the admin
 * RSVP-on-behalf route — so the same value can't get in clean through one door
 * and dirty through the other. The CSV export escapes formula leads as well
 * (see `csvSafe` in ./csv); this stops the obvious payloads at the door and
 * keeps stored data tidy.
 */

const MAX_NAME = 80;
const MAX_DIETARY = 200;
const MAX_MESSAGE = 2000;
const MAX_EMAIL = 254;

/**
 * Normalize a single-line field: drop control and invisible-format characters
 * (which is what carries tab/CR spreadsheet payloads and zero-width homoglyph
 * tricks), collapse whitespace, and cap the length.
 */
function cleanLine(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Same, but newlines survive — the message box is a multi-line note. */
function cleanMultiline(value, max) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? c : " "))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/**
 * A name must contain at least one letter or digit, and must not open with a
 * character that makes a spreadsheet evaluate the cell. Any script is fine —
 * accents, apostrophes, hyphens and non-Latin names all pass — this only
 * rejects things no real name looks like, e.g. `=1+1` or `=HYPERLINK(...)`.
 */
function looksLikeName(value) {
  return /[\p{L}\p{N}]/u.test(value) && !/^[=+\-@]/.test(value);
}

/**
 * Clean an attendee list into `[{name, dietary}]`, dropping entries with no
 * name. Returns `{ attendees, invalid }` — `invalid` is true when any surviving
 * name doesn't look like a name, so the caller can reject with its own message.
 */
function cleanAttendees(list) {
  const attendees = (Array.isArray(list) ? list : [])
    .map((a) => ({
      name: cleanLine(a && a.name, MAX_NAME),
      dietary: cleanLine(a && a.dietary, MAX_DIETARY),
    }))
    .filter((a) => a.name);

  return { attendees, invalid: !attendees.every((a) => looksLikeName(a.name)) };
}

module.exports = {
  cleanLine,
  cleanMultiline,
  looksLikeName,
  cleanAttendees,
  MAX_NAME,
  MAX_DIETARY,
  MAX_MESSAGE,
  MAX_EMAIL,
};
