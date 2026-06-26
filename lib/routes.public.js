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

function mountPublicRoutes(app, ctx) {
  const { store, limiters, requireCsrfHeader, appBaseUrl } = ctx;
  const publicLimiter = limiters.publicLimiter;
  const base = String(appBaseUrl || "").replace(/\/$/, "");

  // Find an invitation by invite code (preferred) or name.
  app.post("/api/lookup", publicLimiter, requireCsrfHeader, (req, res) => {
    if (isBot(req)) return res.json({ match: "none" });

    const { code, name } = req.body || {};
    const result = lookupInvitee(store, { code, name });

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

    if (result.status === "multiple") {
      // Never leak the guest list. Offer admin-curated hints (if any) so the
      // right person can recognize themselves and enter their invite code.
      const hints = result.candidates.map((c) => c.disambiguation_hint).filter(Boolean);
      return res.json({ match: "multiple", hints });
    }

    return res.json({ match: "none" });
  });

  // Load an existing RSVP for editing via the private token from the email link.
  app.get("/api/rsvp", publicLimiter, (req, res) => {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ error: "Missing token" });
    const rsvp = store.getRsvpByEditToken(token);
    if (!rsvp) return res.status(404).json({ error: "Invalid or expired link" });
    req.session.rsvpInviteeId = rsvp.invitee_id;
    res.json({ invitee: publicSafeInvitee(rsvp.invitee), rsvp: rsvpSummary(rsvp) });
  });

  // Create or update an RSVP.
  app.post("/api/rsvp", publicLimiter, requireCsrfHeader, (req, res) => {
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
    const email = String(body.email || "").trim();
    const message = String(body.message || "").trim();
    const maxAttendees = invitee.plus_ones_allotted + 1;

    let attendees = [];
    if (attending) {
      attendees = (Array.isArray(body.attendees) ? body.attendees : [])
        .map((a) => ({
          name: String((a && a.name) || "").trim(),
          dietary: String((a && a.dietary) || "").trim(),
        }))
        .filter((a) => a.name);

      if (attendees.length === 0) {
        return res.status(400).json({ error: "Please list at least one guest who will attend." });
      }
      if (attendees.length > maxAttendees) {
        return res.status(400).json({ error: `You may include up to ${maxAttendees} guest(s).` });
      }
      if (!/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "A valid email is required so we can confirm your RSVP." });
      }
    }

    const saved = store.saveRsvp({
      inviteeId,
      attending,
      email: email || null,
      message: message || null,
      attendees: attendees.map((a, i) => ({ name: a.name, dietary: a.dietary, is_primary: i === 0 })),
    });

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
