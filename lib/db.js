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

function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
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
    updateRsvp: db.prepare(
      `UPDATE rsvp SET attending = @attending, email = @email, message = @message, updated_at = datetime('now')
       WHERE id = @id`
    ),
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

  function createInvitee(data) {
    const row = {
      name: String(data.name || "").trim(),
      name_normalized: normalizeName(data.name),
      plus_ones_allotted: Math.max(0, toInt(data.plus_ones_allotted, 0)),
      invite_code: data.invite_code ? normalizeCode(data.invite_code) : null,
      disambiguation_hint: data.disambiguation_hint ? String(data.disambiguation_hint).trim() : null,
      email: data.email ? String(data.email).trim() : null,
      notes: data.notes ? String(data.notes).trim() : null,
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

  function updateInvitee(id, data) {
    const sets = [];
    const params = { id };
    for (const key of ALLOWED_INVITEE_UPDATE) {
      if (key in data && data[key] !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = data[key] === "" ? null : data[key];
      }
    }
    if ("plus_ones_allotted" in params && params.plus_ones_allotted != null) {
      params.plus_ones_allotted = Math.max(0, toInt(params.plus_ones_allotted, 0));
    }
    if ("invite_code" in params && params.invite_code) {
      params.invite_code = normalizeCode(params.invite_code);
    }
    if ("name" in data && data.name !== undefined) {
      sets.push(`name_normalized = @name_normalized`);
      params.name_normalized = normalizeName(data.name);
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
   */
  const saveRsvp = db.transaction((input) => {
    const invitee = stmts.getInvitee.get(input.inviteeId);
    if (!invitee) throw new Error("Invitee not found");

    const attending = input.attending ? 1 : 0;
    const email = input.email ? String(input.email).trim() : null;
    const message = input.message ? String(input.message).trim() : null;

    let rsvp = stmts.getRsvpByInvitee.get(input.inviteeId);
    if (rsvp) {
      stmts.updateRsvp.run({ id: rsvp.id, attending, email, message });
    } else {
      stmts.insertRsvp.run({
        invitee_id: input.inviteeId,
        attending,
        email,
        message,
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
    return getRsvpFull(rsvp.id);
  });

  function listRsvps(filter) {
    let where = "";
    if (filter === "yes") where = "WHERE r.attending = 1";
    else if (filter === "no") where = "WHERE r.attending = 0";
    else if (filter === "pending") where = "WHERE r.id IS NULL";

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
    if (!admin) return null;
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

module.exports = { open, createStore, SCHEMA };
