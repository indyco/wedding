"use strict";

/**
 * Seed a few demo invitees for local testing. Idempotent: skips invite codes
 * that already exist. Never run this against production data.
 *
 *   node scripts/seed-demo.js
 */

require("dotenv").config();

const { open } = require("../lib/db");
const { formatInviteCode } = require("../lib/codes");

const store = open();

const demo = [
  { name: "Alice Anderson", plus_ones_allotted: 1, invite_code: "10000001" },
  { name: "Bob & Betty Brown", plus_ones_allotted: 1, invite_code: "10000002" },
  { name: "The Garcia Family", plus_ones_allotted: 3, invite_code: "10000003" },
  { name: "John Smith", plus_ones_allotted: 1, invite_code: "10000004", disambiguation_hint: "Oak Street" },
  { name: "John Smith", plus_ones_allotted: 0, invite_code: "10000005", disambiguation_hint: "Elm Avenue" },
  { name: "Solo Sasha", plus_ones_allotted: 0, invite_code: "10000006" },
];

let added = 0;
for (const d of demo) {
  if (!store.getInviteeByCode(d.invite_code)) {
    store.createInvitee(d);
    added += 1;
  }
}

console.log(`Seeded ${added} demo invitee(s). Total invitees: ${store.listInvitees().length}\n`);
console.log("Invite codes for testing the guest flow:");
for (const d of demo) {
  console.log(`  ${formatInviteCode(d.invite_code)}  ${d.name}`);
}
process.exit(0);
