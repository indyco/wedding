"use strict";

/**
 * Regenerate invite codes across the guest list.
 *
 *   node scripts/regen-codes.js         # only invitees missing a code
 *   node scripts/regen-codes.js --all   # give EVERY invitee a fresh code
 *
 * Prints each guest's name and new (dashed) code. Run --all only before invites
 * are printed — it invalidates any codes already handed out.
 */

require("dotenv").config();

const { open } = require("../lib/db");
const { formatInviteCode } = require("../lib/codes");

const all = process.argv.includes("--all");
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
