"use strict";

/**
 * Data layer for the wedding RSVP app.
 *
 * Exposes `open(dbPath)` which returns a "store" object — a thin set of
 * query/transaction helpers over a single better-sqlite3 connection.
 * `createStore(db)` is exported separately so tests can pass their own
 * in-memory database.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const { normalizeName, normalizeCode } = require("./matching");
const { generateInviteCode, isValidInviteCode, CODE_DIGITS } = require("./codes");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invitees (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  name_normalized     TEXT    NOT NULL,
  plus_ones_allotted  INTEGER NOT NULL DEFAULT 0,
  invite_code         TEXT    UNIQUE,
  disambiguation_hint TEXT,
  email               TEXT,
  status              TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'responded'
  notes               TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invitees_name_normalized ON invitees(name_normalized);

CREATE TABLE IF NOT EXISTS rsvp (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invitee_id   INTEGER NOT NULL UNIQUE REFERENCES invitees(id) ON DELETE CASCADE,
  attending    INTEGER NOT NULL DEFAULT 0, -- 0 = no, 1 = yes
  email        TEXT,
  message      TEXT,
  edit_token   TEXT    NOT NULL UNIQUE,
  submitted_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rsvp_edit_token ON rsvp(edit_token);

CREATE TABLE IF NOT EXISTS attendees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rsvp_id    INTEGER NOT NULL REFERENCES rsvp(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  dietary    TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attendees_rsvp_id ON attendees(rsvp_id);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id        TEXT,
  recipient_email     TEXT    NOT NULL,
  subject             TEXT,
  status              TEXT    NOT NULL, -- 'sent' | 'failed' | 'bounced'
  provider_message_id TEXT,
  error               TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_broadcast ON email_log(broadcast_id);
`;

function defaultDbPath() {
  return process.env.DB_PATH || path.join(__dirname, "..", "data", "wedding.db");
}

function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * bcrypt hash of a fixed throwaway string at cost 10, compared against when a
 * login names an unknown user so both paths cost the same. Precomputed rather
 * than hashed at startup to keep process boot (and the test suite) fast.
 */
const TIMING_DECOY_HASH = "$2a$10$FHrtLunaBwk7BrQeuN2BwucLYAuHgKG59yjoSwH1Kln8Z6wdHucoe";

/**
 * A validation failure the caller can fix, tagged with `status` so the admin
 * routes answer 400 instead of 500 — the caller mistyped, the server didn't
 * fail. Thrown here rather than in the routes so the dashboard and CSV import
 * can't be looser than one another.
 */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Reject a human-supplied invite code that isn't the canonical 10 digits. */
function assertValidInviteCode(code) {
  if (isValidInviteCode(code)) return code;
  throw badRequest(
    `Invite code must be exactly ${CODE_DIGITS} digits (leave it blank to generate one)`
  );
}

function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Upper bound on `plus_ones_allotted`, matching the dashboard's stepper. The
 * allotment is what caps how many attendees an RSVP may name, so an unbounded
 * value (a typo, or `99999999999999999999` in a CSV column) silently removes
 * that cap for the guest it lands on.
 */
const MAX_PLUS_ONES = 20;

function clampPlusOnes(value) {
  return Math.max(0, Math.min(MAX_PLUS_ONES, toInt(value, 0)));
}

/**
 * Coerce a nullable text column to a trimmed string, or NULL when blank.
 * better-sqlite3 binds only numbers, strings, bigints, buffers and null — an
 * object or boolean arriving from a JSON body would otherwise throw at bind
 * time, surfacing as a 500 for what is really a malformed field.
 */
function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** A required name: trimmed, never blank (the column is NOT NULL). */
function requireName(value) {
  const name = String(value == null ? "" : value).trim();
  if (!name) throw badRequest("Name is required");
  return name;
}

function open(dbPath) {
  const file = dbPath || defaultDbPath();
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return createStore(db);
}

function createStore(db) {
  const stmts = {
    insertInvitee: db.prepare(
      `INSERT INTO invitees (name, name_normalized, plus_ones_allotted, invite_code, disambiguation_hint, email, notes)
       VALUES (@name, @name_normalized, @plus_ones_allotted, @invite_code, @disambiguation_hint, @email, @notes)`
    ),
    getInvitee: db.prepare(`SELECT * FROM invitees WHERE id = ?`),
    getInviteeByCode: db.prepare(`SELECT * FROM invitees WHERE invite_code = ?`),
    findByNorm: db.prepare(`SELECT * FROM invitees WHERE name_normalized = ? ORDER BY id`),
    deleteInvitee: db.prepare(`DELETE FROM invitees WHERE id = ?`),

    getRsvpById: db.prepare(`SELECT * FROM rsvp WHERE id = ?`),
    getRsvpByInvitee: db.prepare(`SELECT * FROM rsvp WHERE invitee_id = ?`),
    getRsvpByToken: db.prepare(`SELECT * FROM rsvp WHERE edit_token = ?`),
    insertRsvp: db.prepare(
      `INSERT INTO rsvp (invitee_id, attending, email, message, edit_token)
       VALUES (@invitee_id, @attending, @email, @message, @edit_token)`
    ),
    rotateEditToken: db.prepare(`UPDATE rsvp SET edit_token = @edit_token WHERE id = @id`),
    setInviteeStatus: db.prepare(
      `UPDATE invitees SET status = @status, updated_at = datetime('now') WHERE id = @id`
    ),

    deleteAttendees: db.prepare(`DELETE FROM attendees WHERE rsvp_id = ?`),
    insertAttendee: db.prepare(
      `INSERT INTO attendees (rsvp_id, name, is_primary, dietary)
       VALUES (@rsvp_id, @name, @is_primary, @dietary)`
    ),
    getAttendees: db.prepare(`SELECT * FROM attendees WHERE rsvp_id = ? ORDER BY is_primary DESC, id`),

    countAdmins: db.prepare(`SELECT COUNT(*) AS c FROM admins`),
    getAdminByUsername: db.prepare(`SELECT * FROM admins WHERE username = ?`),
    getAdminById: db.prepare(`SELECT * FROM admins WHERE id = ?`),
    insertAdmin: db.prepare(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`),

    insertEmailLog: db.prepare(
      `INSERT INTO email_log (broadcast_id, recipient_email, subject, status, provider_message_id, error)
       VALUES (@broadcast_id, @recipient_email, @subject, @status, @provider_message_id, @error)`
    ),
    listEmailLog: db.prepare(`SELECT * FROM email_log ORDER BY id DESC LIMIT ?`),

    listInvitees: db.prepare(`
      SELECT i.*,
             r.id          AS rsvp_id,
             r.attending   AS attending,
             r.email       AS rsvp_email,
             r.message     AS message,
             r.submitted_at AS submitted_at,
             (SELECT COUNT(*) FROM attendees a WHERE a.rsvp_id = r.id) AS party_size
      FROM invitees i
      LEFT JOIN rsvp r ON r.invitee_id = i.id
      ORDER BY i.name COLLATE NOCASE
    `),

    summary: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM invitees)                       AS invited,
        (SELECT COUNT(*) FROM invitees WHERE status='responded') AS responded,
        (SELECT COUNT(*) FROM invitees WHERE status='pending')   AS pending,
        (SELECT COUNT(*) FROM rsvp WHERE attending=1)            AS attending_parties,
        (SELECT COUNT(*) FROM rsvp WHERE attending=0)            AS declined,
        (SELECT COUNT(*) FROM attendees a JOIN rsvp r ON a.rsvp_id=r.id WHERE r.attending=1) AS headcount
    `),
  };

  // ---- Invitees -----------------------------------------------------------

  /**
   * A generated code guaranteed unique against the current guest list. The
   * invite code is the only thing authenticating a guest, so every invitee gets
   * one — there is no name-based fallback.
   */
  function generateUniqueInviteCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = generateInviteCode();
      if (!stmts.getInviteeByCode.get(code)) return code;
    }
    throw new Error("Could not generate a unique invite code");
  }

  function createInvitee(data) {
    // Invite code is the only way a guest reaches their RSVP, so every invitee
    // gets one: use the provided code (canonicalized to digits) or mint one.
    // Note `provided` is null when the input has no digits at all, so a code
    // like "ABC" mints a fresh one instead of storing an empty string. A code
    // that IS supplied must be full length — a short one is guessable.
    const provided = normalizeCode(data.invite_code) || null;
    if (provided) assertValidInviteCode(provided);
    const name = requireName(data.name);
    const row = {
      name,
      name_normalized: normalizeName(name),
      plus_ones_allotted: clampPlusOnes(data.plus_ones_allotted),
      invite_code: provided || generateUniqueInviteCode(),
      disambiguation_hint: textOrNull(data.disambiguation_hint),
      email: textOrNull(data.email),
      notes: textOrNull(data.notes),
    };
    const info = stmts.insertInvitee.run(row);
    return stmts.getInvitee.get(info.lastInsertRowid);
  }

  const ALLOWED_INVITEE_UPDATE = [
    "name",
    "plus_ones_allotted",
    "invite_code",
    "disambiguation_hint",
    "email",
    "notes",
    "status",
  ];

  /**
   * Normalize one updatable column into a value SQLite can actually bind.
   * `name`, `plus_ones_allotted` and `status` are NOT NULL, so a blank must
   * never be written through as NULL — that is a constraint error, i.e. a 500
   * for what is really a mistyped field.
   */
  function normalizeInviteeField(key, value) {
    if (key === "name") return requireName(value);
    if (key === "plus_ones_allotted") return clampPlusOnes(value);
    if (key === "invite_code") {
      // Canonicalize to digits. Clearing the field (or supplying a value with no
      // digits) regenerates rather than blanking it: code is the only lookup
      // path, so an invitee without one is unreachable. Anything else supplied
      // must be a full-length code.
      const next = normalizeCode(value);
      return next ? assertValidInviteCode(next) : generateUniqueInviteCode();
    }
    return textOrNull(value);
  }

  function updateInvitee(id, data) {
    const sets = [];
    const params = { id };
    for (const key of ALLOWED_INVITEE_UPDATE) {
      if (!(key in data) || data[key] === undefined) continue;
      const value = normalizeInviteeField(key, data[key]);
      // status is NOT NULL: a blank means "leave it alone", not "write NULL".
      if (key === "status" && value === null) continue;
      sets.push(`${key} = @${key}`);
      params[key] = value;
      if (key === "name") {
        sets.push(`name_normalized = @name_normalized`);
        params.name_normalized = normalizeName(value);
      }
    }
    if (sets.length === 0) return stmts.getInvitee.get(id);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE invitees SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return stmts.getInvitee.get(id);
  }

  const deleteInvitee = (id) => stmts.deleteInvitee.run(id).changes > 0;
  const getInvitee = (id) => stmts.getInvitee.get(id);
  const getInviteeByCode = (code) => stmts.getInviteeByCode.get(normalizeCode(code));
  const findInviteesByNormalizedName = (norm) => stmts.findByNorm.all(norm);
  const listInvitees = () => stmts.listInvitees.all();

  // ---- RSVP + attendees ---------------------------------------------------

  function getRsvpFull(rsvpId) {
    const rsvp = stmts.getRsvpById.get(rsvpId);
    if (!rsvp) return null;
    return {
      ...rsvp,
      invitee: stmts.getInvitee.get(rsvp.invitee_id),
      attendees: stmts.getAttendees.all(rsvpId),
    };
  }

  const getRsvpByInviteeId = (inviteeId) => {
    const rsvp = stmts.getRsvpByInvitee.get(inviteeId);
    return rsvp ? getRsvpFull(rsvp.id) : null;
  };

  const getRsvpByEditToken = (token) => {
    const rsvp = stmts.getRsvpByToken.get(token);
    return rsvp ? getRsvpFull(rsvp.id) : null;
  };

  /**
   * Create or update an RSVP and its attendees atomically.
   * input: { inviteeId, attending(bool), email, message, attendees: [{name, dietary, is_primary}] }
   * Attendee count is NOT enforced here — the route validates against the
   * invitee's allotment before calling this.
   *
   * Changing the address on an existing RSVP rotates the edit token, so a
   * previously-issued link can't be reused. The returned object carries
   * `emailChanged` / `previousEmail` so the caller can warn the old address,
   * and `changed` — false when the save was a no-op — so the caller can skip a
   * pointless confirmation email.
   */
  const saveRsvp = db.transaction((input) => {
    const invitee = stmts.getInvitee.get(input.inviteeId);
    if (!invitee) throw new Error("Invitee not found");

    /** Everything a guest can see about their own RSVP, as a comparable string. */
    const signature = (full) =>
      !full
        ? ""
        : JSON.stringify([
            full.attending,
            full.email || "",
            full.message || "",
            (full.attendees || []).map((a) => [a.name, a.dietary || "", a.is_primary ? 1 : 0]),
          ]);
    const priorRow = stmts.getRsvpByInvitee.get(input.inviteeId);
    const before = signature(priorRow ? getRsvpFull(priorRow.id) : null);

    const attending = input.attending ? 1 : 0;
    // undefined => field absent, leave stored value unchanged (update only).
    // "" / null => clear to NULL. Any other value => trimmed string.
    const field = (v) => (v === undefined ? undefined : (v === null || String(v).trim() === "" ? null : String(v).trim()));
    const email = field(input.email);
    const message = field(input.message);

    let rsvp = stmts.getRsvpByInvitee.get(input.inviteeId);
    let previousEmail = null;
    let emailChanged = false;
    if (rsvp) {
      previousEmail = rsvp.email || null;
      // A rotation-worthy change requires all three:
      //  - the caller actually supplied the field (undefined = absent = keep the
      //    stored value, so nothing was redirected and the token must survive),
      //  - there was a real prior address (filling in a blank isn't a redirect),
      //  - and the new value actually differs, ignoring case.
      emailChanged =
        email !== undefined &&
        Boolean(previousEmail) &&
        previousEmail.trim().toLowerCase() !== String(email || "").trim().toLowerCase();
      const sets = ["attending = @attending", "updated_at = datetime('now')"];
      const params = { id: rsvp.id, attending };
      if (email !== undefined) { sets.push("email = @email"); params.email = email; }
      if (message !== undefined) { sets.push("message = @message"); params.message = message; }
      db.prepare(`UPDATE rsvp SET ${sets.join(", ")} WHERE id = @id`).run(params);
      if (emailChanged) {
        stmts.rotateEditToken.run({ id: rsvp.id, edit_token: newToken() });
      }
    } else {
      stmts.insertRsvp.run({
        invitee_id: input.inviteeId,
        attending,
        email: email === undefined ? null : email,
        message: message === undefined ? null : message,
        edit_token: newToken(),
      });
      rsvp = stmts.getRsvpByInvitee.get(input.inviteeId);
    }

    stmts.deleteAttendees.run(rsvp.id);
    if (attending) {
      const list = Array.isArray(input.attendees) ? input.attendees : [];
      list.forEach((a, i) => {
        const name = String(a && a.name ? a.name : "").trim();
        if (!name) return;
        stmts.insertAttendee.run({
          rsvp_id: rsvp.id,
          name,
          is_primary: a.is_primary || i === 0 ? 1 : 0,
          dietary: a && a.dietary ? String(a.dietary).trim() : null,
        });
      });
    }

    stmts.setInviteeStatus.run({ id: input.inviteeId, status: "responded" });
    // Read back after any rotation so the caller gets the current token.
    const full = getRsvpFull(rsvp.id);
    return { ...full, emailChanged, previousEmail, changed: signature(full) !== before };
  });

  function listRsvps(filter) {
    let where = "";
    if (filter === "yes") where = "WHERE r.attending = 1";
    else if (filter === "no") where = "WHERE r.attending = 0";
    else if (filter === "pending") where = "WHERE r.id IS NULL";
    else if (filter === "responded") where = "WHERE r.id IS NOT NULL";

    const rows = db
      .prepare(
        `SELECT i.id AS invitee_id, i.name, i.invite_code, i.plus_ones_allotted, i.status,
                r.id AS rsvp_id, r.attending, r.email, r.message, r.submitted_at, r.updated_at
         FROM invitees i
         LEFT JOIN rsvp r ON r.invitee_id = i.id
         ${where}
         ORDER BY i.name COLLATE NOCASE`
      )
      .all();

    return rows.map((row) => ({
      ...row,
      attendees: row.rsvp_id ? stmts.getAttendees.all(row.rsvp_id) : [],
    }));
  }

  const getSummary = () => stmts.summary.get();

  // ---- Admins -------------------------------------------------------------

  const countAdmins = () => stmts.countAdmins.get().c;
  const getAdminByUsername = (username) => stmts.getAdminByUsername.get(username);
  const getAdminById = (id) => stmts.getAdminById.get(id);

  function createAdmin(username, passwordHash) {
    const info = stmts.insertAdmin.run(username, passwordHash);
    return stmts.getAdminById.get(info.lastInsertRowid);
  }

  function updateAdminCredentials(id, { username, password }) {
    const sets = [];
    const params = { id };
    if (username !== undefined && username !== null && String(username).trim() !== "") {
      sets.push(`username = @username`);
      params.username = String(username).trim();
    }
    if (password) {
      sets.push(`password_hash = @password_hash`);
      params.password_hash = bcrypt.hashSync(String(password), 10);
    }
    if (sets.length === 0) return getAdminById(id);
    sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE admins SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return getAdminById(id);
  }

  /**
   * Create the first admin from env on a fresh database.
   * If no password is supplied, generate a random one and return it so the
   * caller can print it once. No-op if an admin already exists.
   */
  function bootstrapAdmin({ username, password } = {}) {
    if (countAdmins() > 0) return { created: false };
    const finalUser = (username && String(username).trim()) || "admin";
    let finalPass = password ? String(password) : "";
    let generated = false;
    if (!finalPass) {
      finalPass = crypto.randomBytes(12).toString("base64url");
      generated = true;
    }
    createAdmin(finalUser, bcrypt.hashSync(finalPass, 10));
    return { created: true, username: finalUser, generated, password: generated ? finalPass : undefined };
  }

  function verifyAdmin(username, password) {
    const admin = getAdminByUsername(username);
    if (!admin) {
      // Burn the same bcrypt work as a real check would, so response time
      // doesn't reveal whether the username exists. The decoy is a hash of a
      // fixed throwaway string at the same cost factor — it is never a usable
      // credential, since no admin row carries it.
      bcrypt.compareSync(String(password), TIMING_DECOY_HASH);
      return null;
    }
    return bcrypt.compareSync(String(password), admin.password_hash) ? admin : null;
  }

  // ---- Email log ----------------------------------------------------------

  function logEmail(entry) {
    stmts.insertEmailLog.run({
      broadcast_id: entry.broadcast_id || null,
      recipient_email: entry.recipient_email,
      subject: entry.subject || null,
      status: entry.status,
      provider_message_id: entry.provider_message_id || null,
      error: entry.error || null,
    });
  }

  const listEmailLog = (limit = 200) => stmts.listEmailLog.all(Math.max(1, toInt(limit, 200)));

  return {
    db,
    // invitees
    createInvitee,
    generateUniqueInviteCode,
    updateInvitee,
    deleteInvitee,
    getInvitee,
    getInviteeByCode,
    findInviteesByNormalizedName,
    listInvitees,
    // rsvp
    saveRsvp,
    getRsvpByInviteeId,
    getRsvpByEditToken,
    listRsvps,
    getSummary,
    // admins
    countAdmins,
    getAdminByUsername,
    getAdminById,
    createAdmin,
    updateAdminCredentials,
    bootstrapAdmin,
    verifyAdmin,
    // email
    logEmail,
    listEmailLog,
  };
}

// Invite-code generation lives in ./codes — import it from there, not via this
// module, so there is a single source of truth for the code format.
module.exports = { open, createStore, SCHEMA };
