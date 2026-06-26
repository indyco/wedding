"use strict";

/**
 * Email transport. Wraps Resend behind a generic `sendEmail({to, subject, text, html})`
 * so the rest of the app never imports the provider directly (SMTP could be
 * swapped in here later). When no API key is configured, emails are logged to
 * the console instead of sent, so local development works without Resend.
 */

const { Resend } = require("resend");

function createEmailer(config = {}) {
  const apiKey = config.apiKey || process.env.RESEND_API_KEY || "";
  const from = config.from || process.env.EMAIL_FROM || "Wedding RSVP <onboarding@resend.dev>";
  const resend = apiKey ? new Resend(apiKey) : null;

  async function sendEmail({ to, subject, text, html } = {}) {
    if (!to) throw new Error("sendEmail: missing recipient");

    if (!resend) {
      // Dev/local fallback — no provider configured.
      console.log(
        `[email:dev] would send -> to=${to} subject=${JSON.stringify(subject)}\n${text || html || ""}\n`
      );
      return { id: `dev-${Date.now()}`, dev: true };
    }

    const payload = { from, to, subject };
    if (text) payload.text = text;
    if (html) payload.html = html;

    const { data, error } = await resend.emails.send(payload);
    if (error) {
      throw new Error(error.message || JSON.stringify(error));
    }
    return { id: data && data.id };
  }

  return { sendEmail, hasProvider: Boolean(resend), from };
}

module.exports = { createEmailer };
