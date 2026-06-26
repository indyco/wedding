"use strict";

/**
 * CSV import/export for the guest list and responses.
 */

const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { normalizeName } = require("./matching");

// Map friendly/variant column headers to canonical field names.
const HEADER_ALIASES = {
  name: "name",
  guest: "name",
  invitee: "name",
  plus_ones_allotted: "plus_ones_allotted",
  plus_ones: "plus_ones_allotted",
  plusones: "plus_ones_allotted",
  "plus ones": "plus_ones_allotted",
  allotment: "plus_ones_allotted",
  email: "email",
  "e-mail": "email",
  invite_code: "invite_code",
  code: "invite_code",
  "invite code": "invite_code",
  disambiguation_hint: "disambiguation_hint",
  hint: "disambiguation_hint",
  notes: "notes",
  note: "notes",
};

function canonicalHeader(h) {
  const key = String(h == null ? "" : h).trim().toLowerCase();
  return HEADER_ALIASES[key] || key;
}

/**
 * Import invitees from CSV text. Upserts by invite_code when present, otherwise
 * by normalized name (a single match updates; multiple matches are skipped as
 * ambiguous). Returns { inserted, updated, skipped, errors:[{row, error}] }.
 */
function importInviteesFromCsv(store, csvText) {
  const records = parse(csvText, {
    bom: true,
    columns: (header) => header.map(canonicalHeader),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };

  records.forEach((row, idx) => {
    const rowNum = idx + 2; // +1 for header, +1 for 1-based
    const name = String(row.name || "").trim();
    if (!name) {
      result.skipped += 1;
      result.errors.push({ row: rowNum, error: "Missing name" });
      return;
    }

    const data = { name };
    if (row.plus_ones_allotted !== undefined && row.plus_ones_allotted !== "") {
      data.plus_ones_allotted = row.plus_ones_allotted;
    }
    if (row.email) data.email = row.email;
    if (row.invite_code) data.invite_code = row.invite_code;
    if (row.disambiguation_hint) data.disambiguation_hint = row.disambiguation_hint;
    if (row.notes) data.notes = row.notes;

    let existing = null;
    if (row.invite_code) {
      existing = store.getInviteeByCode(row.invite_code);
    } else {
      const matches = store.findInviteesByNormalizedName(normalizeName(name));
      if (matches.length === 1) {
        existing = matches[0];
      } else if (matches.length > 1) {
        result.skipped += 1;
        result.errors.push({ row: rowNum, error: `Ambiguous name "${name}" (already appears multiple times); add an invite_code` });
        return;
      }
    }

    try {
      if (existing) {
        store.updateInvitee(existing.id, data);
        result.updated += 1;
      } else {
        store.createInvitee(data);
        result.inserted += 1;
      }
    } catch (e) {
      result.skipped += 1;
      const msg = /UNIQUE/i.test(String(e && e.message))
        ? "Invite code already in use by another guest"
        : String((e && e.message) || e);
      result.errors.push({ row: rowNum, error: msg });
    }
  });

  return result;
}

/**
 * Export all responses as CSV — one row per attending guest (great for the
 * caterer), plus a single row for pending/declined invitees.
 */
function exportResponsesToCsv(store) {
  const rows = store.listRsvps();
  const out = [];

  for (const r of rows) {
    if (r.rsvp_id && r.attending === 1 && r.attendees.length > 0) {
      for (const a of r.attendees) {
        out.push({
          invitee: r.name,
          status: "attending",
          guest_name: a.name,
          dietary: a.dietary || "",
          email: r.email || "",
          invite_code: r.invite_code || "",
          message: r.message || "",
        });
      }
    } else {
      let status = "pending";
      if (r.rsvp_id) status = r.attending === 1 ? "attending (no names given)" : "declined";
      out.push({
        invitee: r.name,
        status,
        guest_name: "",
        dietary: "",
        email: r.email || "",
        invite_code: r.invite_code || "",
        message: r.message || "",
      });
    }
  }

  return stringify(out, {
    header: true,
    columns: ["invitee", "status", "guest_name", "dietary", "email", "invite_code", "message"],
  });
}

module.exports = { importInviteesFromCsv, exportResponsesToCsv, canonicalHeader };
