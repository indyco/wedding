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

const DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "::1"];

/** Compare IPs without tripping over IPv4-mapped IPv6 form. */
function normalizeIp(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");
}

function parseTrustedProxies(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return [...DEFAULT_TRUSTED_PROXIES];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Real client IP, for rate-limit bucketing.
 *
 * `CF-Connecting-IP` is set by Cloudflare and is the only way to tell guests
 * apart behind the tunnel — without it every request looks like it came from
 * cloudflared itself and all guests would share one bucket. But it's just a
 * header: anything that can reach this process directly could forge it and get
 * a fresh bucket per request, defeating every limiter. So it's honored only
 * when the immediate peer is a trusted proxy address; otherwise we key on the
 * socket address, which cannot be spoofed.
 */
function makeClientIp(trustedProxies) {
  const trusted = new Set(trustedProxies.map(normalizeIp));
  return function clientIp(req) {
    const peer = normalizeIp(req.socket && req.socket.remoteAddress);
    if (!trusted.has(peer)) return peer || "unknown";

    const forwarded = req.headers["cf-connecting-ip"];
    if (forwarded) return normalizeIp(String(forwarded).split(",")[0]);
    // Express applies `trust proxy` to X-Forwarded-For for us.
    return normalizeIp(req.ip) || peer || "unknown";
  };
}

/** Back-compat default used when no trusted-proxy list is configured. */
const clientIp = makeClientIp(DEFAULT_TRUSTED_PROXIES);

function makeLimiter(keyGenerator, opts) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    // The key comes from our own trusted-peer check above, so skip
    // express-rate-limit's proxy/IP validations (avoids false warnings).
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

const DEV_SESSION_SECRET = "dev-insecure-secret-change-me";

/**
 * Resolve the session secret, refusing to start in production without a real
 * one. This repo is public, so any fallback or placeholder that ships in it is
 * known to everyone — it must never be able to sign production cookies.
 * Outside production a weak default is allowed, but warned about.
 */
function resolveSessionSecret({ secret, isProd }) {
  const value = String(secret == null ? "" : secret).trim();

  if (isProd) {
    if (!value) {
      throw new Error("SESSION_SECRET must be set when NODE_ENV=production");
    }
    if (value === DEV_SESSION_SECRET || /change[-_ ]?me/i.test(value)) {
      throw new Error(
        "SESSION_SECRET is still a placeholder — generate one with:\n" +
          `  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
      );
    }
    if (value.length < 32) {
      throw new Error(`SESSION_SECRET must be at least 32 characters (got ${value.length})`);
    }
    return value;
  }

  if (!value) {
    console.warn(
      "[warn] No SESSION_SECRET set — using an insecure development default. Never serve production this way."
    );
    return DEV_SESSION_SECRET;
  }
  return value;
}

/**
 * Parse RSVP_DEADLINE into a Date, or null when unset (RSVPs never close).
 * A bare `YYYY-MM-DD` means the end of that day UTC; pass a full ISO timestamp
 * if you need a specific local time. Throws on a malformed value rather than
 * silently leaving RSVPs open forever.
 */
function parseDeadline(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new Error(
      `Invalid RSVP_DEADLINE ${JSON.stringify(raw)} — use YYYY-MM-DD or a full ISO 8601 timestamp`
    );
  }
  return at;
}

function createApp({ store, sendEmail, config = {} } = {}) {
  if (!store) throw new Error("createApp requires a store");

  const app = express();
  const isProd = (config.nodeEnv || process.env.NODE_ENV) === "production";
  const appBaseUrl = config.appBaseUrl || process.env.APP_BASE_URL || "http://localhost:3000";
  const rsvpDeadline = parseDeadline(
    config.rsvpDeadline !== undefined ? config.rsvpDeadline : process.env.RSVP_DEADLINE
  );
  const sessionSecret = resolveSessionSecret({
    secret: config.sessionSecret !== undefined ? config.sessionSecret : process.env.SESSION_SECRET,
    isProd,
  });

  // cloudflared is the single proxy in front of us. Trust forwarding headers
  // only from these peers — `trust proxy: 1` would trust whoever connected,
  // which is wrong for anything that can reach this process directly.
  const trustedProxies = parseTrustedProxies(
    config.trustedProxies !== undefined ? config.trustedProxies : process.env.TRUSTED_PROXY_IPS
  );
  const resolveClientIp = makeClientIp(trustedProxies);
  app.set("trust proxy", trustedProxies);
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
      secret: sessionSecret,
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
  const authLimiter = makeLimiter(resolveClientIp, {
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Too many attempts. Please try again later." },
  });
  const writeLimiter = makeLimiter(resolveClientIp, {
    windowMs: 5 * 60 * 1000,
    max: 60,
    message: { error: "Too many requests. Please slow down." },
  });
  const publicLimiter = makeLimiter(resolveClientIp, {
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
    rsvpDeadline,
    limiters: { authLimiter, writeLimiter, publicLimiter },
    requireAdmin,
    requireCsrfHeader,
    clientIp: resolveClientIp,
  };

  // ---- Auth routes --------------------------------------------------------
  app.get("/api/me", (req, res) => {
    if (req.session && req.session.adminId) {
      return res.json({ authenticated: true, username: req.session.username });
    }
    res.json({ authenticated: false });
  });

  app.post("/api/admin/login", authLimiter, requireCsrfHeader, (req, res, next) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    const admin = store.verifyAdmin(username, password);
    if (!admin) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    // Issue a fresh session ID on login (session fixation): a session that
    // already existed before authenticating — a guest lookup, or one an
    // attacker managed to plant — must not become an admin session. This also
    // drops any guest `rsvpInviteeId` carried in the old session.
    req.session.regenerate((regenErr) => {
      if (regenErr) return next(regenErr);
      req.session.adminId = admin.id;
      req.session.username = admin.username;
      // Persist before responding, so the new ID is stored even if the client
      // immediately fires the next request.
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.json({ message: "Login successful", username: admin.username });
      });
    });
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

module.exports = {
  createApp,
  requireCsrfHeader,
  clientIp,
  makeClientIp,
  parseTrustedProxies,
  parseDeadline,
  resolveSessionSecret,
};
