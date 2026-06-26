# wedding

A small, self-hosted wedding RSVP site: a pre-loaded guest list with per-guest +1 allotments, named attendees, an admin dashboard, and a broadcast email to everyone who RSVP'd **yes**. Built with Express + SQLite.

## Features

- Guests find themselves by **invite code (preferred)** or by **name as it appears on the invite**.
- RSVP yes/no; if yes, name each attendee (up to the invitee's +1 allotment) with optional dietary notes.
- Guests can edit their response later via a private link emailed to them.
- Admin dashboard: manage the guest list and +1 allotments, import/export CSV, view/filter responses and headcounts, and send a broadcast email to attending guests.
- Security-first: designed to sit behind Cloudflare (Tunnel + Access), with app-level rate limiting, CSRF protection, hashed passwords, and a honeypot.

## Requirements

- Node.js >= 20 (developed on Node 22).

## Setup

```bash
npm install
cp .env.example .env    # then edit .env (see Configuration)
npm start               # http://localhost:3000
npm run dev             # auto-restart on changes
```

On first start an admin account is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Change the credentials anytime from the dashboard, or run `npm run reset-admin` on the server.

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

## Deployment (behind Cloudflare)

Run `npm start` under your process supervisor (systemd/pm2). Expose it with a **Cloudflare Tunnel** (`cloudflared`) so no inbound ports are opened and the origin IP stays hidden. Protect the admin area with a **Cloudflare Access** policy on the `/admin` path — the allow-list of permitted emails lives in the Cloudflare Zero Trust dashboard, **never in this repo**. Set `NODE_ENV=production` and the real `APP_BASE_URL` once the hostname is chosen.

## Security / public-repo notes

This repo is public, so secrets and allow-lists are never committed:

- `.env`, the SQLite DB, logs, and any `cloudflared` credentials are gitignored.
- The Cloudflare Access email allow-list is configured in Cloudflare, not in code.

## Project layout

- `server.js` — Express entry (middleware + routes).
- `lib/` — `db.js`, `matching.js`, `email.js`, `csv.js`.
- `scripts/` — `reset-admin.js`, `seed-demo.js`.
- `public/` — guest + admin UI.
- `data/` — runtime SQLite DB (gitignored).
- `test/` — unit + integration tests (`npm test`).
