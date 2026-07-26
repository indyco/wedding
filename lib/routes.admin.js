"use strict";

/**
 * Admin routes — all require an authenticated admin session. State-changing
 * routes also require the CSRF header and the write rate limiter.
 */

const crypto = require("crypto");
const { importInviteesFromCsv, exportResponsesToCsv, exportCatererCsv } = require("./csv");
const { cleanLine, cleanMultiline, cleanAttendees, MAX_MESSAGE, MAX_EMAIL } = require("./sanitize");

// An email subject is a single header line. Resend takes JSON so a newline
// wouldn't smuggle a header there, but normalizing means we aren't relying on
// the transport's escaping if it is ever swapped for raw SMTP.
const MAX_SUBJECT = 200;
const MAX_BODY = 10000;

function isUniqueErr(e) {
  return /UNIQUE/i.test(String((e && e.message) || ""));
}

/**
 * Turn a store-level validation error (e.g. a malformed invite code) into the
 * 400 it is, rather than letting it fall through to the 500 handler. Returns
 * true when it handled the error.
 */
function sendIfBadRequest(res, e) {
  if (!e || e.status !== 400) return false;
  res.status(400).json({ error: e.message });
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEmail(v) {
  return /.+@.+\..+/.test(String(v || "").trim());
}

/**
 * A route :id as a positive integer, or null. Guards the store from a NaN bind
 * (better-sqlite3 throws on it), which would surface as a 500 where the honest
 * answer is 404 — the id in the URL isn't one we could ever have issued.
 */
function inviteeId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function mountAdminRoutes(app, ctx) {
  const { store, limiters, requireAdmin, requireCsrfHeader } = ctx;
  const writeLimiter = limiters.writeLimiter;

  // ---- Read views ---------------------------------------------------------
  app.get("/api/admin/invitees", requireAdmin, (req, res) => {
    res.json(store.listInvitees());
  });

  app.get("/api/admin/summary", requireAdmin, (req, res) => {
    res.json(store.getSummary());
  });

  app.get("/api/admin/rsvps", requireAdmin, (req, res) => {
    res.json(store.listRsvps(req.query.filter));
  });

  // ---- Invitee CRUD -------------------------------------------------------
  app.post("/api/admin/invitees", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    try {
      res.status(201).json(store.createInvitee(req.body));
    } catch (e) {
      if (isUniqueErr(e)) return res.status(409).json({ error: "That invite code is already in use" });
      if (sendIfBadRequest(res, e)) return;
      throw e;
    }
  });

  app.patch("/api/admin/invitees/:id", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const id = inviteeId(req.params.id);
    if (!id || !store.getInvitee(id)) return res.status(404).json({ error: "Invitee not found" });
    try {
      res.json(store.updateInvitee(id, req.body || {}));
    } catch (e) {
      if (isUniqueErr(e)) return res.status(409).json({ error: "That invite code is already in use" });
      if (sendIfBadRequest(res, e)) return;
      throw e;
    }
  });

  app.delete("/api/admin/invitees/:id", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const id = inviteeId(req.params.id);
    if (!id || !store.deleteInvitee(id)) return res.status(404).json({ error: "Invitee not found" });
    res.json({ ok: true });
  });

  // RSVP on behalf of a guest (e.g. they lost their card / phoned it in). Unlike
  // the public path, email is optional here and no confirmation email is sent.
  app.post("/api/admin/invitees/:id/rsvp", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const id = inviteeId(req.params.id);
    const invitee = id ? store.getInvitee(id) : null;
    if (!invitee) return res.status(404).json({ error: "Invitee not found" });

    const body = req.body || {};
    const attending = body.attending === true || body.attending === "yes" || body.attending === 1 || body.attending === "1";
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    // Same normalization as the public form: this data lands in the same tables
    // and the same CSV export, so it can't get in through a looser door.
    const email = has("email") ? cleanLine(body.email, MAX_EMAIL) : undefined;
    const message = has("message") ? cleanMultiline(body.message, MAX_MESSAGE) : undefined;

    let attendees = [];
    if (attending) {
      const cleaned = cleanAttendees(body.attendees);
      attendees = cleaned.attendees;
      if (attendees.length === 0) {
        return res.status(400).json({ error: "List at least one attending guest." });
      }
      if (cleaned.invalid) {
        return res.status(400).json({ error: "Enter each guest's name using letters." });
      }
      if (attendees.length > invitee.plus_ones_allotted + 1) {
        return res.status(400).json({ error: `You may include up to ${invitee.plus_ones_allotted + 1} guest(s).` });
      }
    }

    const saved = store.saveRsvp({
      inviteeId: id,
      attending,
      email,
      message,
      attendees: attendees.map((a, i) => ({ name: a.name, dietary: a.dietary, is_primary: i === 0 })),
    });
    res.json({
      ok: true,
      attending,
      attendees: saved.attendees.map((a) => ({ name: a.name, dietary: a.dietary || "" })),
    });
  });

  // ---- CSV import / export ------------------------------------------------
  app.post("/api/admin/invitees/import", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const csvText = req.body && typeof req.body.csv === "string" ? req.body.csv : "";
    if (!csvText.trim()) {
      return res.status(400).json({ error: "Provide CSV text in the 'csv' field" });
    }
    try {
      res.json(importInviteesFromCsv(store, csvText));
    } catch (e) {
      res.status(400).json({ error: "Could not parse CSV: " + ((e && e.message) || e) });
    }
  });

  app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
    const csv = exportResponsesToCsv(store);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="wedding-rsvps.csv"');
    res.send(csv);
  });

  // Caterer-scoped export: dietary restrictions + headcount only. Deliberately
  // omits names, emails, invite codes, and messages (data minimization).
  app.get("/api/admin/export-caterer.csv", requireAdmin, (req, res) => {
    const csv = exportCatererCsv(store);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="caterer-dietary.csv"');
    res.send(csv);
  });

  // ---- Broadcast email ----------------------------------------------------
  // Send a single test email to a chosen address (preview before the real blast).
  app.post("/api/admin/broadcast/test", writeLimiter, requireAdmin, requireCsrfHeader, async (req, res) => {
    const subject = cleanLine((req.body && req.body.subject) || "", MAX_SUBJECT);
    const body = cleanMultiline((req.body && req.body.body) || "", MAX_BODY);
    const to = cleanLine((req.body && req.body.to) || "", MAX_EMAIL);
    if (!subject || !body) return res.status(400).json({ error: "Subject and body are required" });
    if (!isEmail(to)) return res.status(400).json({ error: "Provide a valid 'to' email for the test" });
    if (!ctx.sendEmail) return res.status(503).json({ error: "Email is not configured" });
    try {
      const r = await ctx.sendEmail({ to, subject, text: body });
      store.logEmail({ broadcast_id: "test", recipient_email: to, subject, status: "sent", provider_message_id: r && r.id });
      res.json({ ok: true });
    } catch (e) {
      store.logEmail({ broadcast_id: "test", recipient_email: to, subject, status: "failed", error: String((e && e.message) || e) });
      res.status(502).json({ error: "Failed to send test email: " + ((e && e.message) || e) });
    }
  });

  // Send to every unique email that RSVP'd "yes" (throttled; each send logged).
  app.post("/api/admin/broadcast", writeLimiter, requireAdmin, requireCsrfHeader, async (req, res) => {
    const subject = cleanLine((req.body && req.body.subject) || "", MAX_SUBJECT);
    const body = cleanMultiline((req.body && req.body.body) || "", MAX_BODY);
    if (!subject || !body) return res.status(400).json({ error: "Subject and body are required" });
    if (!ctx.sendEmail) return res.status(503).json({ error: "Email is not configured" });

    const seen = new Set();
    const recipients = [];
    for (const r of store.listRsvps("yes")) {
      const email = String(r.email || "").trim();
      const key = email.toLowerCase();
      if (isEmail(email) && !seen.has(key)) {
        seen.add(key);
        recipients.push(email);
      }
    }

    const broadcastId = crypto.randomUUID();
    let sent = 0;
    let failed = 0;
    for (const email of recipients) {
      try {
        const r = await ctx.sendEmail({ to: email, subject, text: body });
        store.logEmail({ broadcast_id: broadcastId, recipient_email: email, subject, status: "sent", provider_message_id: r && r.id });
        sent += 1;
      } catch (e) {
        store.logEmail({ broadcast_id: broadcastId, recipient_email: email, subject, status: "failed", error: String((e && e.message) || e) });
        failed += 1;
      }
      await sleep(120); // gentle throttle to stay well under provider limits
    }

    res.json({ ok: true, broadcast_id: broadcastId, total: recipients.length, sent, failed });
  });

  app.get("/api/admin/email-log", requireAdmin, (req, res) => {
    res.json(store.listEmailLog(Number(req.query.limit) || 200));
  });
}

module.exports = { mountAdminRoutes };
