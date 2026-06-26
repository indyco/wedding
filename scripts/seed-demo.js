"use strict";

/**
 * Seed a few demo invitees for local testing. Idempotent: skips invite codes
 * that already exist. Never run this against production data.
 *
 *   node scripts/seed-demo.js
 */

require("dotenv").config();

const { open } = require("../lib/db");

const store = open();

const demo = [
  { name: "Alice Anderson", plus_ones_allotted: 1, invite_code: "ALICE1" },
  { name: "Bob & Betty Brown", plus_ones_allotted: 1, invite_code: "BROWN2" },
  { name: "The Garcia Family", plus_ones_allotted: 3, invite_code: "GARCIA3" },
  { name: "John Smith", plus_ones_allotted: 1, invite_code: "JS-OAK", disambiguation_hint: "Oak Street" },
  { name: "John Smith", plus_ones_allotted: 0, invite_code: "JS-ELM", disambiguation_hint: "Elm Avenue" },
  { name: "Solo Sasha", plus_ones_allotted: 0, invite_code: "SASHA0" },
];

let added = 0;
for (const d of demo) {
  if (!store.getInviteeByCode(d.invite_code)) {
    store.createInvitee(d);
    added += 1;
  }
}

console.log(`Seeded ${added} demo invitee(s). Total invitees: ${store.listInvitees().length}`);
process.exit(0);
