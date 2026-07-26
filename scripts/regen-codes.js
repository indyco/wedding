"use strict";

/**
 * Regenerate invite codes across the guest list.
 *
 *   node scripts/regen-codes.js               # only invitees missing a code
 *   node scripts/regen-codes.js --all --yes   # give EVERY invitee a fresh code
 *
 * Prints each guest's name and new (dashed) code. `--all` invalidates every code
 * already handed out, so it additionally requires --yes and is safe to run only
 * before invitations are sent.
 */

require("dotenv").config();

const { open } = require("../lib/db");
const { formatInviteCode } = require("../lib/codes");

const all = process.argv.includes("--all");

if (all && !process.argv.includes("--yes")) {
  console.error("--all rewrites every invite code, breaking any already sent to guests.");
  console.error("Re-run with --yes if that's what you want:");
  console.error("  node scripts/regen-codes.js --all --yes");
  process.exit(1);
}

const store = open();

let changed = 0;
for (const inv of store.listInvitees()) {
  if (!all && inv.invite_code) continue;
  const code = store.generateUniqueInviteCode();
  store.updateInvitee(inv.id, { invite_code: code });
  console.log(`${inv.name}: ${formatInviteCode(code)}`);
  changed += 1;
}

console.log(`\nUpdated ${changed} invite code(s)${all ? "" : " (missing only)"}.`);
process.exit(0);
