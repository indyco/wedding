"use strict";

/**
 * Express application factory.
 *
 * `createApp({ store, sendEmail, config })` returns a configured app without
 * starting a listener, so tests can drive it with supertest and inject an
 * in-memory store / fake email transport.
 */

const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const SqliteStore = require("better-sqlite3-session-store")(session);
const { mountPublicRoutes } = require("./routes.public");
const { mountAdminRoutes } = require("./routes.admin");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

/** Real client IP — behind Cloudflare it's in CF-Connecting-IP. */
function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    req.ip ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown"
  );
}

function makeLimiter(opts) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIp,
    // We intentionally derive the key from CF-Connecting-IP behind Cloudflare,
    // so disable express-rate-limit's proxy/IP validations (avoids false warnings).
    validate: false,
    ...opts,
  });
}

/**
 * CSRF defense (matches indy.nexus): browsers cannot set a custom header on a
 * cross-origin form post without a CORS preflight, which we never allow. Paired
 * with sameSite:strict session cookies this blocks CSRF on state-changing routes.
 */
function requireCsrfHeader(req, res, next) {
  if (req.headers["x-requested-with"] !== "XMLHttpRequest") {
    return res.status(403).json({ error: "CSRF check failed" });
  }
  next();
}

function createApp({ store, sendEmail, config = {} } = {}) {
  if (!store) throw new Error("createApp requires a store");

  const app = express();
  const isProd = (config.nodeEnv || process.env.NODE_ENV) === "production";
  const appBaseUrl = config.appBaseUrl || process.env.APP_BASE_URL || "http://localhost:3000";

  // cloudflared is the single proxy in front of us in production.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Baseline security headers (the UI uses same-origin assets only).
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
    );
    next();
  });

  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: true, limit: "100kb" }));

  app.use(
    session({
      store: new SqliteStore({
        client: store.db,
        expired: { clear: true, intervalMs: 15 * 60 * 1000 },
      }),
      name: "wedding.sid",
      secret: config.sessionSecret || process.env.SESSION_SECRET || "dev-insecure-secret-change-me",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: isProd,
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );

  // ---- Rate limiters ------------------------------------------------------
  const authLimiter = makeLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many attempts. Please try again later." },
  });
  const writeLimiter = makeLimiter({
    windowMs: 5 * 60 * 1000,
    max: 60,
    message: { error: "Too many requests. Please slow down." },
  });
  const publicLimiter = makeLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: "Too many requests. Please slow down." },
  });

  // ---- Auth helpers -------------------------------------------------------
  function requireAdmin(req, res, next) {
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    next();
  }

  // Shared context handed to mounted route groups.
  const ctx = {
    store,
    sendEmail,
    appBaseUrl,
    limiters: { authLimiter, writeLimiter, publicLimiter },
    requireAdmin,
    requireCsrfHeader,
    clientIp,
  };

  // ---- Auth routes --------------------------------------------------------
  app.get("/api/me", (req, res) => {
    if (req.session && req.session.adminId) {
      return res.json({ authenticated: true, username: req.session.username });
    }
    res.json({ authenticated: false });
  });

  app.post("/api/admin/login", authLimiter, requireCsrfHeader, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    const admin = store.verifyAdmin(username, password);
    if (!admin) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    res.json({ message: "Login successful", username: admin.username });
  });

  app.post("/api/admin/logout", requireCsrfHeader, (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out" }));
  });

  app.post("/api/admin/change-credentials", writeLimiter, requireAdmin, requireCsrfHeader, (req, res) => {
    const { currentPassword, newUsername, newPassword } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required" });
    }
    const admin = store.getAdminById(req.session.adminId);
    if (!admin || !store.verifyAdmin(admin.username, currentPassword)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    if (!newUsername && !newPassword) {
      return res.status(400).json({ error: "Provide a new username and/or a new password" });
    }
    if (newPassword && String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    if (newUsername) {
      const existing = store.getAdminByUsername(String(newUsername).trim());
      if (existing && existing.id !== admin.id) {
        return res.status(409).json({ error: "That username is already taken" });
      }
    }
    const updated = store.updateAdminCredentials(admin.id, { username: newUsername, password: newPassword });
    req.session.username = updated.username;
    res.json({ message: "Credentials updated", username: updated.username });
  });

  // ---- Public RSVP routes -------------------------------------------------
  mountPublicRoutes(app, ctx);

  // ---- Admin routes -------------------------------------------------------
  mountAdminRoutes(app, ctx);

  // ===== ADDITIONAL ROUTE GROUPS MOUNTED ABOVE THIS LINE ===================
  // (broadcast — added in a later step)

  // ---- Static assets + 404 ------------------------------------------------
  // Serve the admin dashboard HTML at /admin (Cloudflare Access gates this in prod).
  app.get(["/admin", "/admin/"], (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
  });
  app.use(express.static(PUBLIC_DIR));

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // JSON error handler (last middleware).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[error]", err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp, requireCsrfHeader, clientIp };
