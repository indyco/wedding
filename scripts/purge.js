"use strict";

/**
 * Post-wedding data purge. Removes personal data once it is no longer needed —
 * the highest-value privacy control we have (dietary notes edge into health /
 * religion data). Refuses to run without --yes (prints a dry-run summary first).
 *
 *   node scripts/purge.js            # dry run: report what WOULD be removed
 *   node scripts/purge.js --yes      # anonymize: drop PII, keep aggregate counts
 *   node scripts/purge.js --yes --hard   # teardown: also delete RSVP/attendee rows
 *
 * Default (--yes): attendee names -> "guest", dietary/email/message/hint/notes
 * cleared, email log emptied. Attendee rows and attending flags are KEPT so
 * headcount aggregates still compute. --hard additionally deletes all rsvp and
 * attendee rows and anonymizes invitee names (only the invitee count survives).
 */

require("dotenv").config();

const { open } = require("../lib/db");

const yes = process.argv.includes("--yes");
const hard = process.argv.includes("--hard");
const store = open();
const db = store.db;

const stats = {
  invitees: db.prepare("SELECT COUNT(*) c FROM invitees").get().c,
  rsvps: db.prepare("SELECT COUNT(*) c FROM rsvp").get().c,
  attendees: db.prepare("SELECT COUNT(*) c FROM attendees").get().c,
  emailsOnFile: db.prepare("SELECT COUNT(*) c FROM rsvp WHERE email IS NOT NULL").get().c,
  emailLog: db.prepare("SELECT COUNT(*) c FROM email_log").get().c,
};

if (!yes) {
  console.log("DRY RUN — nothing was changed. Re-run with --yes to apply.\n");
  console.log(`  Invitees:            ${stats.invitees}`);
  console.log(`  RSVPs:               ${stats.rsvps}`);
  console.log(`  Attendee rows:       ${stats.attendees}`);
  console.log(`  Emails on file:      ${stats.emailsOnFile}`);
  console.log(`  Email-log entries:   ${stats.emailLog}`);
  console.log(`\n  --yes  will clear attendee names, dietary notes, emails, messages, hints, notes, and the email log.`);
  console.log(`  --hard will additionally delete all RSVP/attendee rows and anonymize invitee names.`);
  process.exit(0);
}

const purge = db.transaction(() => {
  db.prepare("DELETE FROM email_log").run();
  db.prepare("UPDATE invitees SET email = NULL, disambiguation_hint = NULL, notes = NULL, updated_at = datetime('now')").run();

  if (hard) {
    db.prepare("DELETE FROM attendees").run();
    db.prepare("DELETE FROM rsvp").run();
    db.prepare("UPDATE invitees SET name = 'Guest ' || id, name_normalized = '', updated_at = datetime('now')").run();
  } else {
    db.prepare("UPDATE attendees SET name = 'guest', dietary = NULL").run();
    db.prepare("UPDATE rsvp SET email = NULL, message = NULL, updated_at = datetime('now')").run();
  }
});

purge();

console.log(hard ? "Hard purge complete: all personal data and RSVP/attendee rows removed." : "Purge complete: personal data cleared; aggregate headcounts retained.");
process.exit(0);
