# wedding

A small, self-hosted wedding RSVP site: a pre-loaded guest list with per-guest +1 allotments, named attendees, an admin dashboard, and a broadcast email to everyone who RSVP'd **yes**. Built with Express + SQLite.

## Features

- Guests find themselves by their **invite code** (10 digits, shown dashed as `12345-67890`). Code is the only lookup path — name lookup was removed so the guest list can't be enumerated.
- RSVP yes/no; if yes, name each attendee (up to the invitee's +1 allotment) with optional dietary notes.
- Guests can edit their response later via a private link emailed to them.
- Admin dashboard: manage the guest list and +1 allotments, RSVP on a guest's behalf, import/export CSV (incl. a caterer-only dietary export), view/filter responses and headcounts, and send a broadcast email to attending guests.
- Security-first: designed to sit behind Cloudflare (Tunnel + Access), with app-level rate limiting, CSRF protection, hashed passwords, and a honeypot.

## Requirements

- Node.js >= 20 (developed on Node 22).

## Setup

```bash
npm install
cp .env.example .env    # then edit .env (see Configuration)
npm start               # http://localhost:3000
npm run dev             # auto-restart on changes
npm run seed-demo       # optional: load a few demo invitees for local testing
```

On first start an admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Change the credentials anytime from the dashboard, or run `npm run reset-admin` on the server.

To try the app with sample data, run `npm run seed-demo`. It loads a handful of demo invitees and prints their invite codes (e.g. `10000-00001` for Alice, `10000-00003` for the Garcia family) so you can exercise the guest lookup and RSVP flow immediately. It's idempotent (skips codes that already exist) and is intended for local testing only — never run it against production data.

## Configuration

All configuration is via environment variables (see `.env.example`). **Never commit `.env`.**

- `PORT` — HTTP port (default `3000`).
- `BIND_HOST` — interface to bind (default `127.0.0.1`, i.e. loopback only). Set
  `0.0.0.0` only when `cloudflared` runs on a different host.
- `TRUSTED_PROXY_IPS` — comma-separated peers whose `CF-Connecting-IP` /
  `X-Forwarded-For` headers are trusted (default `127.0.0.1,::1`). Requests from
  other peers are rate-limited by their real socket address.
- `NODE_ENV` — `development` | `production` (production enables secure cookies).
- `SESSION_SECRET` — long random string for signing session cookies.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — first-run admin bootstrap.
- `RESEND_API_KEY`, `EMAIL_FROM` — Resend email sending.
- `APP_BASE_URL` — public base URL used in email links (set to the real `https` URL at the very end).
- `RSVP_DEADLINE` — when RSVPs close (`YYYY-MM-DD` = end of that day UTC, or a full
  ISO 8601 timestamp). After it, lookups and submissions are refused and every
  emailed edit link stops working. Unset means nothing ever expires.
- `DB_PATH` — optional override for the SQLite file (default `./data/wedding.db`).

## Data & backups

All runtime data lives in a single SQLite file at `data/wedding.db` (gitignored). Back it up regularly — e.g. a nightly copy of the file, or Litestream for continuous replication on Linux.

**Invite codes.** New invitees are assigned a random 10-digit code (CSPRNG) automatically — a 10^10 space, so guessing is impractical against the public rate limit. The code is the only way a guest reaches their RSVP, so its length is load-bearing; change `CODE_DIGITS` in `lib/codes.js` only upward. `node scripts/regen-codes.js` assigns codes to any invitee missing one; adding `--all --yes` re-rolls every code (only before invites are printed — it invalidates any already handed out).

**Post-wedding purge.** `npm run purge` prints a dry run of what would be removed. `npm run purge -- --yes` clears personal data (attendee names, dietary notes, emails, messages) while keeping aggregate headcounts; add `--hard` to also delete all RSVP/attendee rows and anonymize invitee names. Dietary notes can imply health/religion data, so purge once you no longer need the details.

## Deployment (behind Cloudflare)

Run `npm start` under your process supervisor (systemd/pm2). Expose it with a **Cloudflare Tunnel** (`cloudflared`) so no inbound ports are opened and the origin IP stays hidden. Run `cloudflared` on the same host as the app and leave `BIND_HOST` at its `127.0.0.1` default, so nothing else on the LAN — or in a sibling container — can reach the origin directly and forge `CF-Connecting-IP` to escape rate limiting. Point the tunnel's ingress at `http://localhost:3000` — not the host's LAN IP, which the loopback bind refuses.

Protect the admin area with a **Cloudflare Access** policy covering **both** `/admin*` **and** `/api/admin*`. Covering only `/admin` leaves the login endpoint reachable from the internet: it still returns 401 without a valid session, but a bot can attempt passwords against it (10 per 15 min per IP). Access sets its cookie for the whole hostname, so the dashboard's `fetch()` calls to `/api/admin/*` keep working once you've passed Access. The allow-list of permitted emails lives in the Cloudflare Zero Trust dashboard, **never in this repo**.

Set `NODE_ENV=production` and the real `APP_BASE_URL` once the hostname is chosen. Leave `ADMIN_PASSWORD` **unset** on a fresh deploy: a random password is generated and printed once to the startup log, which avoids ever running with the placeholder from `.env.example` — a value anyone can read in this public repo.

## Security / public-repo notes

This repo is public, so secrets and allow-lists are never committed:

- `.env`, the SQLite DB, logs, and any `cloudflared` credentials are gitignored.
- The Cloudflare Access email allow-list is configured in Cloudflare, not in code.
- Disambiguation hints are admin-only notes and are never returned to guests
  (name lookup was removed), so they're safe for whatever helps you tell
  same-named guests apart.

## Project layout

- `server.js` — Express entry (middleware + routes).
- `lib/` — `db.js`, `matching.js`, `codes.js`, `email.js`, `csv.js`.
- `scripts/` — `reset-admin.js`, `seed-demo.js`, `regen-codes.js`, `purge.js`, `backup-db.js`.
- `public/` — guest + admin UI.
- `data/` — runtime SQLite DB (gitignored).
- `test/` — unit + integration tests (`npm test`).
