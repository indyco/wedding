"use strict";

/**
 * wedding — RSVP site entry point.
 * Loads env, opens the database, bootstraps the admin, and starts the server.
 */

require("dotenv").config();

const { open } = require("./lib/db");
const { createApp, parseDeadline } = require("./lib/app");
const { createEmailer } = require("./lib/email");

const store = open();

// First-run admin bootstrap (no-op once an admin exists).
const boot = store.bootstrapAdmin({
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
});
if (boot.created) {
  console.log(`[bootstrap] Admin account "${boot.username}" created.`);
  if (boot.generated) {
    console.log("[bootstrap] No ADMIN_PASSWORD was set — a random password was generated:");
    console.log(`[bootstrap]   ${boot.password}`);
    console.log("[bootstrap] Log in and change it now (or set ADMIN_PASSWORD and restart on a fresh DB).");
  }
}

const emailer = createEmailer({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM,
});
if (!emailer.hasProvider) {
  console.log("[email] RESEND_API_KEY not set — emails will be logged to the console instead of sent.");
}

const app = createApp({
  store,
  sendEmail: emailer.sendEmail,
  config: {
    nodeEnv: process.env.NODE_ENV,
    sessionSecret: process.env.SESSION_SECRET,
    appBaseUrl: process.env.APP_BASE_URL,
    rsvpDeadline: process.env.RSVP_DEADLINE,
  },
});

// Surface the resolved deadline at startup — a bare date means end of day UTC,
// so print what the app actually settled on rather than the raw string.
const deadline = parseDeadline(process.env.RSVP_DEADLINE);
console.log(
  deadline
    ? `[rsvp] RSVPs close at ${deadline.toISOString()} — edit links stop working then.`
    : "[rsvp] No RSVP_DEADLINE set — RSVPs and edit links never expire."
);

const PORT = process.env.PORT || 3000;
// Loopback by default: cloudflared runs alongside the app and connects locally,
// so nothing else on the LAN (or another container on the same host) can reach
// this process directly. Set BIND_HOST=0.0.0.0 only if the tunnel runs on a
// different machine — and know that it re-opens header spoofing from the LAN
// unless those addresses are in TRUSTED_PROXY_IPS.
const HOST = process.env.BIND_HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`[server] wedding RSVP listening on http://${HOST}:${PORT}`);
});
