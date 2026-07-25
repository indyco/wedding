"use strict";

/**
 * Replace every invitee's invite code with a freshly generated strong one and
 * print the old -> new mapping.
 *
 * Only safe to run BEFORE invitations go out — it invalidates any code a guest
 * already has. Requires --yes so it can't be run by accident later.
 *
 *   node scripts/regen-invite-codes.js --yes
 */

require("dotenv").config();

const { open } = require("../lib/db");

if (!process.argv.includes("--yes")) {
  console.error("This rewrites every invite code, breaking any already sent to guests.");
  console.error("Re-run with --yes if that's what you want:");
  console.error("  node scripts/regen-invite-codes.js --yes");
  process.exit(1);
}

const store = open();
const invitees = store.listInvitees();

for (const inv of invitees) {
  const before = inv.invite_code || "(none)";
  // Passing an empty code makes the store generate a fresh unique one.
  const after = store.updateInvitee(inv.id, { invite_code: "" }).invite_code;
  console.log(`${inv.name}: ${before} -> ${after}`);
}

console.log(`\nRegenerated ${invitees.length} invite code(s).`);
process.exit(0);
