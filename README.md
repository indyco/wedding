# wedding

A small, self-hosted wedding RSVP site: a pre-loaded guest list with per-guest +1 allotments, named attendees, an admin dashboard, and a broadcast email to everyone who RSVP'd **yes**. Built with Express + SQLite.

## Features

- Guests find themselves by **invite code (preferred)** or by **name as it appears on the invite**.
- Every invitee is assigned a random 8-character invite code (no easily-misread
  characters) when created, so codes can't be guessed from a guest's name.
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

## Deployment (behind Cloudflare)

Run `npm start` under your process supervisor (systemd/pm2). Expose it with a **Cloudflare Tunnel** (`cloudflared`) so no inbound ports are opened and the origin IP stays hidden. Run `cloudflared` on the same host as the app and leave `BIND_HOST` at its `127.0.0.1` default, so nothing else on the LAN — or in a sibling container — can reach the origin directly and forge `CF-Connecting-IP` to escape rate limiting. Point the tunnel's ingress at `http://localhost:3000` — not the host's LAN IP, which the loopback bind refuses.

Protect the admin area with a **Cloudflare Access** policy covering **both** `/admin*` **and** `/api/admin*`. Covering only `/admin` leaves the login endpoint reachable from the internet: it still returns 401 without a valid session, but a bot can attempt passwords against it (10 per 15 min per IP). Access sets its cookie for the whole hostname, so the dashboard's `fetch()` calls to `/api/admin/*` keep working once you've passed Access. The allow-list of permitted emails lives in the Cloudflare Zero Trust dashboard, **never in this repo**.

Set `NODE_ENV=production` and the real `APP_BASE_URL` once the hostname is chosen. Leave `ADMIN_PASSWORD` **unset** on a fresh deploy: a random password is generated and printed once to the startup log, which avoids ever running with the placeholder from `.env.example` — a value anyone can read in this public repo.

## Security / public-repo notes

This repo is public, so secrets and allow-lists are never committed:

- `.env`, the SQLite DB, logs, and any `cloudflared` credentials are gitignored.
- The Cloudflare Access email allow-list is configured in Cloudflare, not in code.
- Disambiguation hints are shown to **unauthenticated** visitors who look up a
  duplicated name, so keep them vague (“college friend”), never addresses or
  other personal details.

## Project layout

- `server.js` — Express entry (middleware + routes).
- `lib/` — `db.js`, `matching.js`, `email.js`, `csv.js`.
- `scripts/` — `reset-admin.js`, `seed-demo.js`, `regen-invite-codes.js`.
- `public/` — guest + admin UI.
- `data/` — runtime SQLite DB (gitignored).
- `test/` — unit + integration tests (`npm test`).
