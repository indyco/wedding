# CLAUDE.md

Wedding RSVP site — Express + SQLite (better-sqlite3); dependency-free vanilla JS
UI in `public/` (no build step, no framework). Node >= 20. Repo
`github.com/indyco/wedding`, branch `main`. Config: see `.env.example`.

## Commands

- `npm start` — run (http://localhost:3000); `npm run dev` — watch mode.
- `npm test` — full suite (`node --test` + supertest); `node --test test/rsvp.test.js` — one file.
- `npm run reset-admin` | `seed-demo` | `regen-codes` | `purge` | `backup`. No linter configured.
- `node scripts/regen-codes.js --all --yes` — rewrite every invite code (pre-send
  only). Call node directly: PowerShell swallows the `--` in `npm run … -- --flag`.

## Map

- `server.js` — entry: load env, open store, bootstrap admin, start listener.
- `lib/app.js` — `createApp({store, sendEmail, config})`: headers/CSP, session,
  rate limiters, auth routes; mounts route groups; returns app (no `listen`) for supertest.
- `lib/db.js` — SQLite store; all data access. Auto-assigns a random `invite_code`
  on create (and when one is cleared) — never leave an invitee without one, it is
  the only lookup path. Changing an RSVP's email rotates its `edit_token`.
- `lib/sanitize.js` — `cleanLine`/`cleanMultiline`/`cleanAttendees`; used by BOTH
  the public RSVP route and admin RSVP-on-behalf so neither is a looser door.
- `lib/routes.public.js` — `/api/lookup`, `/api/rsvp`. Both close once
  `RSVP_DEADLINE` passes (403/410 with `closed: true`), which also expires edit links.
- `lib/routes.admin.js` — invitee CRUD, RSVP-on-behalf, CSV import/export
  (+caterer dietary export), summary, rsvps, broadcast (+test), email-log
  (all require admin session).
- `lib/matching.js` — lookup by invite code only (name lookup removed).
  `lib/codes.js` — CSPRNG 10-digit invite-code generation + dashed formatting;
  the single source of truth for code format (`CODE_DIGITS`, `isValidInviteCode`).
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
- `h()` has no raw-HTML escape hatch, by design — use `text` or child strings
  (both become text nodes). Never introduce `innerHTML`; a test asserts its absence.
- JSON responses; errors are `{ error }`. Keep `npm test` green.

## Guardrails

- Do not change timeout settings: session `maxAge` and rate-limit `windowMs`
  (`lib/app.js`), and the broadcast `sleep` throttle (`lib/routes.admin.js`).
- Rate-limit keys come from `makeClientIp`: `CF-Connecting-IP` is honored only
  from a `TRUSTED_PROXY_IPS` peer. Never key limiters straight off a header.
- An invite code is exactly `CODE_DIGITS` digits, enforced in `lib/db.js`
  (`assertValidInviteCode`) so the dashboard and CSV import can't differ. It is
  the guest's only credential — a short one is brute-forceable within the rate
  limit. Blank means "generate one", never "store an empty code".
- Deploy with `NODE_ENV=production`: the session cookie's `Secure` flag and the
  SESSION_SECRET strength check both key off it. The app warns at startup when
  `APP_BASE_URL` is https but NODE_ENV isn't production.
- Every CSV export must route guest/admin text through `csvSafe` (`lib/csv.js`) —
  a bare value beginning `= + - @` executes when the file is opened in a spreadsheet.
- Keep source files free of NUL bytes: one stray NUL made git treat `lib/csv.js`
  as binary, which silently discarded a whole fix during a merge.
- Never commit `.env`, the SQLite DB, or secrets/allow-lists; keep CSP strict.
  (Runs behind Cloudflare Tunnel + Access; allow-lists live in Cloudflare.)
- Don't commit unless asked.
