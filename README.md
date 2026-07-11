# wedding

A small, self-hosted wedding RSVP site: a pre-loaded guest list with per-guest +1 allotments, named attendees, an admin dashboard, and a broadcast email to everyone who RSVP'd **yes**. Built with Express + SQLite.

## Features

- Guests find themselves by their **invite code** (8 digits, shown dashed as `1234-5678`). Code is the only lookup path — name lookup was removed so the guest list can't be enumerated.
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

To try the app with sample data, run `npm run seed-demo`. It loads a handful of demo invitees and prints their invite codes (e.g. `1000-0001` for Alice, `1000-0003` for the Garcia family) so you can exercise the guest lookup and RSVP flow immediately. It's idempotent (skips codes that already exist) and is intended for local testing only — never run it against production data.

## Configuration

All configuration is via environment variables (see `.env.example`). **Never commit `.env`.**

- `PORT` — HTTP port (default `3000`).
- `NODE_ENV` — `development` | `production` (production enables secure cookies).
- `SESSION_SECRET` — long random string for signing session cookies.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` — first-run admin bootstrap.
- `RESEND_API_KEY`, `EMAIL_FROM` — Resend email sending.
- `APP_BASE_URL` — public base URL used in email links (set to the real `https` URL at the very end).
- `DB_PATH` — optional override for the SQLite file (default `./data/wedding.db`).

## Data & backups

All runtime data lives in a single SQLite file at `data/wedding.db` (gitignored). Back it up regularly — e.g. a nightly copy of the file, or Litestream for continuous replication on Linux.

**Invite codes.** New invitees are assigned a random 8-digit code (CSPRNG) automatically. `npm run regen-codes` assigns codes to any invitee missing one; `npm run regen-codes -- --all` re-rolls every code (do this only before invites are printed — it invalidates any already handed out).

**Post-wedding purge.** `npm run purge` prints a dry run of what would be removed. `npm run purge -- --yes` clears personal data (attendee names, dietary notes, emails, messages) while keeping aggregate headcounts; add `--hard` to also delete all RSVP/attendee rows and anonymize invitee names. Dietary notes can imply health/religion data, so purge once you no longer need the details.

## Deployment (behind Cloudflare)

Run `npm start` under your process supervisor (systemd/pm2). Expose it with a **Cloudflare Tunnel** (`cloudflared`) so no inbound ports are opened and the origin IP stays hidden. Protect the admin area with a **Cloudflare Access** policy on the `/admin` path — the allow-list of permitted emails lives in the Cloudflare Zero Trust dashboard, **never in this repo**. Set `NODE_ENV=production` and the real `APP_BASE_URL` once the hostname is chosen.

## Security / public-repo notes

This repo is public, so secrets and allow-lists are never committed:

- `.env`, the SQLite DB, logs, and any `cloudflared` credentials are gitignored.
- The Cloudflare Access email allow-list is configured in Cloudflare, not in code.

## Project layout

- `server.js` — Express entry (middleware + routes).
- `lib/` — `db.js`, `matching.js`, `codes.js`, `email.js`, `csv.js`.
- `scripts/` — `reset-admin.js`, `seed-demo.js`, `regen-codes.js`, `purge.js`, `backup-db.js`.
- `public/` — guest + admin UI.
- `data/` — runtime SQLite DB (gitignored).
- `test/` — unit + integration tests (`npm test`).
