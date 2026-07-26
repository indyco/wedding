"use strict";

/**
 * Admin routes — all require an authenticated admin session. State-changing
 * routes also require the CSRF header and the write rate limiter.
 */

const crypto = require("crypto");
const { importInviteesFromCsv, exportResponsesToCsv, exportCatererCsv } = require("./csv");
const { cleanLine, cleanMultiline, cleanAttendees, MAX_MESSAGE, MAX_EMAIL } = require("./sanitize");

function isUniqueErr(e) {
  return /UNIQUE/i.test(String((e && e.message) || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEmail(v) {
  return /.+@.+\..+/.test(String(v || "").trim());
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
      throw e;
    }
  });

  app.patch("/api/admin/invitees/:id", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const id = Number(req.params.id);
    if (!store.getInvitee(id)) return res.status(404).json({ error: "Invitee not found" });
    try {
      res.json(store.updateInvitee(id, req.body || {}));
    } catch (e) {
      if (isUniqueErr(e)) return res.status(409).json({ error: "That invite code is already in use" });
      throw e;
    }
  });

  app.delete("/api/admin/invitees/:id", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const id = Number(req.params.id);
    if (!store.deleteInvitee(id)) return res.status(404).json({ error: "Invitee not found" });
    res.json({ ok: true });
  });

  // RSVP on behalf of a guest (e.g. they lost their card / phoned it in). Unlike
  // the public path, email is optional here and no confirmation email is sent.
  app.post("/api/admin/invitees/:id/rsvp", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const id = Number(req.params.id);
    const invitee = store.getInvitee(id);
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
    const subject = String((req.body && req.body.subject) || "").trim();
    const body = String((req.body && req.body.body) || "").trim();
    const to = String((req.body && req.body.to) || "").trim();
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
    const subject = String((req.body && req.body.subject) || "").trim();
    const body = String((req.body && req.body.body) || "").trim();
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
