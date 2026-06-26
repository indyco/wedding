"use strict";

/**
 * wedding — RSVP site entry point.
 * Loads env, opens the database, bootstraps the admin, and starts the server.
 */

require("dotenv").config();

const { open } = require("./lib/db");
const { createApp } = require("./lib/app");
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
  },
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] wedding RSVP running on http://localhost:${PORT}`);
});
