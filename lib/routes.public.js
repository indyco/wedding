"use strict";

/**
 * Public (guest-facing) RSVP routes.
 *
 * Authorization model: a guest must first match their invitation via
 * POST /api/lookup (which stores the authorized invitee id in their session)
 * or arrive with a valid edit token. POST /api/rsvp then trusts only that
 * server-side state — never a client-supplied invitee id.
 */

const { lookupInvitee } = require("./matching");

function publicSafeInvitee(inv) {
  return { name: inv.name, plus_ones_allotted: inv.plus_ones_allotted };
}

function rsvpSummary(rsvp) {
  if (!rsvp) return null;
  return {
    attending: !!rsvp.attending,
    email: rsvp.email || "",
    message: rsvp.message || "",
    attendees: (rsvp.attendees || []).map((a) => ({
      name: a.name,
      dietary: a.dietary || "",
      is_primary: !!a.is_primary,
    })),
  };
}

// Honeypot: real users never fill the hidden "company" field.
function isBot(req) {
  return Boolean(req.body && String(req.body.company || "").trim());
}

function isTruthy(v) {
  return v === true || v === "yes" || v === 1 || v === "1" || v === "true";
}

const MAX_NAME = 80;
const MAX_DIETARY = 200;
const MAX_MESSAGE = 2000;

/**
 * Normalize a single-line free-text field: drop control and invisible-format
 * characters (which is what carries tab/CR spreadsheet payloads and homoglyph
 * tricks), collapse whitespace, and cap the length.
 */
function cleanLine(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Same, but newlines survive — the message box is a multi-line note. */
function cleanMultiline(value, max) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? c : " "))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/**
 * A name must contain at least one letter or digit, and must not open with a
 * character that makes a spreadsheet evaluate the cell. Any script is fine —
 * accents, apostrophes, hyphens and non-Latin names all pass — this only
 * rejects things no real name looks like, e.g. `=1+1` or `=HYPERLINK(...)`.
 * The CSV export escapes these too; this just stops them at the door.
 */
function looksLikeName(value) {
  return /[\p{L}\p{N}]/u.test(value) && !/^[=+\-@]/.test(value);
}

function mountPublicRoutes(app, ctx) {
  const { store, limiters, requireCsrfHeader, appBaseUrl, rsvpDeadline } = ctx;
  const publicLimiter = limiters.publicLimiter;
  const base = String(appBaseUrl || "").replace(/\/$/, "");

  /**
   * After the deadline the whole guest-facing surface closes: no lookups, no
   * submissions, and previously-emailed edit links stop working. Unset means
   * RSVPs never close.
   */
  function rsvpsClosed() {
    return Boolean(rsvpDeadline) && Date.now() > rsvpDeadline.getTime();
  }

  const CLOSED_MESSAGE = "RSVPs are now closed. Please contact the couple directly.";

  // Find an invitation by invite code. Code is the only lookup path — name-based
  // lookup was removed because it leaks the guest list (an enumeration oracle).
  app.post("/api/lookup", publicLimiter, requireCsrfHeader, (req, res) => {
    if (rsvpsClosed()) return res.status(403).json({ error: CLOSED_MESSAGE, closed: true });
    if (isBot(req)) return res.json({ match: "none" });

    const { code } = req.body || {};
    const result = lookupInvitee(store, { code });

    if (result.status === "unique") {
      const inv = result.invitee;
      req.session.rsvpInviteeId = inv.id;
      const existing = store.getRsvpByInviteeId(inv.id);
      return res.json({
        match: "unique",
        invitee: publicSafeInvitee(inv),
        rsvp: rsvpSummary(existing),
      });
    }

    return res.json({ match: "none" });
  });

  // Load an existing RSVP for editing via the private token from the email link.
  app.get("/api/rsvp", publicLimiter, (req, res) => {
    if (rsvpsClosed()) return res.status(410).json({ error: CLOSED_MESSAGE, closed: true });
    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ error: "Missing token" });
    const rsvp = store.getRsvpByEditToken(token);
    if (!rsvp) return res.status(404).json({ error: "Invalid or expired link" });
    req.session.rsvpInviteeId = rsvp.invitee_id;
    res.json({ invitee: publicSafeInvitee(rsvp.invitee), rsvp: rsvpSummary(rsvp) });
  });

  // Create or update an RSVP.
  app.post("/api/rsvp", publicLimiter, requireCsrfHeader, (req, res) => {
    if (rsvpsClosed()) return res.status(403).json({ error: CLOSED_MESSAGE, closed: true });
    if (isBot(req)) return res.status(400).json({ error: "Bad request" });
    const body = req.body || {};

    // Authorize via edit token (editing) or a prior lookup in this session.
    let inviteeId = null;
    if (body.editToken) {
      const existing = store.getRsvpByEditToken(String(body.editToken));
      if (!existing) return res.status(404).json({ error: "Invalid or expired link" });
      inviteeId = existing.invitee_id;
    } else if (req.session && req.session.rsvpInviteeId) {
      inviteeId = req.session.rsvpInviteeId;
    }
    if (!inviteeId) {
      return res.status(403).json({ error: "Please look up your invitation first." });
    }

    const invitee = store.getInvitee(inviteeId);
    if (!invitee) return res.status(404).json({ error: "Invitation not found" });

    const attending = isTruthy(body.attending);
    // Presence-aware fields: a key absent from the body leaves the stored value
    // unchanged; an explicit "" (or null) deliberately clears it. This prevents a
    // partial update (e.g. a decline-edit that omits email) from clobbering data.
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    let email = has("email") ? String(body.email == null ? "" : body.email).trim() : undefined;
    const message = has("message") ? String(body.message == null ? "" : body.message).trim() : undefined;
    const maxAttendees = invitee.plus_ones_allotted + 1;

    let attendees = [];
    if (attending) {
      attendees = (Array.isArray(body.attendees) ? body.attendees : [])
        .map((a) => ({
          name: cleanLine(a && a.name, MAX_NAME),
          dietary: cleanLine(a && a.dietary, MAX_DIETARY),
        }))
        .filter((a) => a.name);

      if (attendees.length === 0) {
        return res.status(400).json({ error: "Please list at least one guest who will attend." });
      }
      if (!attendees.every((a) => looksLikeName(a.name))) {
        return res.status(400).json({ error: "Please enter each guest's name using letters." });
      }
      if (attendees.length > maxAttendees) {
        return res.status(400).json({ error: `You may include up to ${maxAttendees} guest(s).` });
      }
      // A contactable email is required to confirm an attending RSVP.
      if (!email || !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "A valid email is required so we can confirm your RSVP." });
      }
    }

    const saved = store.saveRsvp({
      inviteeId,
      attending,
      email,
      message,
      attendees: attendees.map((a, i) => ({ name: a.name, dietary: a.dietary, is_primary: i === 0 })),
    });

    // Warn the address that was replaced, so a redirection someone else made
    // doesn't go unnoticed. Deliberately carries no edit link — the new token
    // belongs to the new address only.
    if (ctx.sendEmail && saved.emailChanged && saved.previousEmail) {
      const subject = "The email on your wedding RSVP was changed";
      const text = [
        `The contact address on the RSVP for ${invitee.name} was changed to ${saved.email || "(none)"}.`,
        "",
        "Any earlier edit link sent to this address no longer works.",
        "If you didn't make this change, please contact the couple directly.",
      ].join("\n");
      const to = saved.previousEmail;

      Promise.resolve(ctx.sendEmail({ to, subject, text }))
        .then((r) =>
          store.logEmail({ recipient_email: to, subject, status: "sent", provider_message_id: r && r.id })
        )
        .catch((err) =>
          store.logEmail({
            recipient_email: to,
            subject,
            status: "failed",
            error: String((err && err.message) || err),
          })
        );
    }

    // Best-effort confirmation email (never blocks or fails the response).
    if (ctx.sendEmail && saved.email) {
      const editLink = `${base}/?edit=${saved.edit_token}`;
      const subject = attending ? "Your RSVP is confirmed 🎉" : "Your RSVP has been received";
      const text = (attending
        ? [
            `Thank you! We have you down with ${saved.attendees.length} guest(s).`,
            "",
            "Need to make a change? Update your response any time here:",
            editLink,
          ]
        : [
            "Thanks for letting us know you can't make it — we'll miss you!",
            "",
            "If your plans change, you can update your response here:",
            editLink,
          ]
      ).join("\n");

      Promise.resolve(ctx.sendEmail({ to: saved.email, subject, text }))
        .then((r) =>
          store.logEmail({
            recipient_email: saved.email,
            subject,
            status: "sent",
            provider_message_id: r && r.id,
          })
        )
        .catch((err) =>
          store.logEmail({
            recipient_email: saved.email,
            subject,
            status: "failed",
            error: String((err && err.message) || err),
          })
        );
    }

    res.json({
      ok: true,
      attending,
      attendees: saved.attendees.map((a) => ({ name: a.name, dietary: a.dietary || "" })),
      edit_token: saved.edit_token,
    });
  });
}

module.exports = { mountPublicRoutes };
