# CLAUDE.md

Wedding RSVP site — Express + SQLite (better-sqlite3); dependency-free vanilla JS
UI in `public/` (no build step, no framework). Node >= 20. Repo
`github.com/indyco/wedding`, branch `main`. Config: see `.env.example`.

## Commands

- `npm start` — run (http://localhost:3000); `npm run dev` — watch mode.
- `npm test` — full suite (`node --test` + supertest); `node --test test/rsvp.test.js` — one file.
- `npm run reset-admin` | `seed-demo` | `backup`. No linter configured.

## Map

- `server.js` — entry: load env, open store, bootstrap admin, start listener.
- `lib/app.js` — `createApp({store, sendEmail, config})`: headers/CSP, session,
  rate limiters, auth routes; mounts route groups; returns app (no `listen`) for supertest.
- `lib/db.js` — SQLite store; all data access.
- `lib/routes.public.js` — `/api/lookup`, `/api/rsvp`.
- `lib/routes.admin.js` — invitee CRUD, CSV import/export, summary, rsvps,
  broadcast (+test), email-log (all require admin session).
- `lib/matching.js` — lookup by code/name + disambiguation hints.
- `lib/email.js` — Resend; logs to console when no API key. `lib/csv.js` — CSV import/export.
- `public/` — `index.html`+`js/guest.js` (guest flow), `admin.html`+`js/admin.js`
  (dashboard tabs), `js/common.js` (`h`/`api`/`clearNode`), `css/styles.css`.
- `scripts/`, `test/`, `data/` (gitignored DB).

## Conventions

- CommonJS (`"use strict"`, `require`/`module.exports`).
- No inline scripts (CSP `script-src 'self'`): JS only in `public/js/*.js`; wire
  handlers via `addEventListener` (`h()` supports `onclick`). Inline `style=""`
  is allowed; no external/CDN assets.
- Always request through `api()` — it sends the `X-Requested-With` CSRF header.
- UI: mount into `#app`, re-render by clear+rebuild with `h(tag, attrs, ...children)`;
  `api(method, url, body)` → `{ ok, status, data }`.
- JSON responses; errors are `{ error }`. Keep `npm test` green.

## Guardrails

- Do not change timeout settings: session `maxAge` and rate-limit `windowMs`
  (`lib/app.js`), and the broadcast `sleep` throttle (`lib/routes.admin.js`).
- Never commit `.env`, the SQLite DB, or secrets/allow-lists; keep CSP strict.
  (Runs behind Cloudflare Tunnel + Access; allow-lists live in Cloudflare.)
- Don't commit unless asked.
