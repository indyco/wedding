# Deployment

This app is a single long-running Node process with a SQLite file — host it the
same way as `indy.nexus`, behind Cloudflare.

## 1. Environment

Copy `.env.example` to `.env` and fill it in. Generate strong secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))" # ADMIN_PASSWORD
```

Key variables: `PORT`, `NODE_ENV=production`, `SESSION_SECRET`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD`, `RESEND_API_KEY`, `EMAIL_FROM`, `APP_BASE_URL`.

> Set `NODE_ENV=production` so session cookies are marked `Secure` (HTTPS-only).
> Leave `APP_BASE_URL` as localhost until the final step.

## 2. Run it

```bash
npm ci
npm start
```

### systemd (Linux example)

```ini
# /etc/systemd/system/wedding.service
[Unit]
Description=wedding RSVP
After=network.target

[Service]
WorkingDirectory=/opt/wedding
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/wedding/.env
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now wedding
```

On Windows, run under the same supervisor you use for `indy.nexus` (e.g. pm2 or a
Scheduled Task / NSSM service running `node server.js`).

## 3. Cloudflare Tunnel

Expose the app without opening any inbound ports; the origin IP stays hidden.

```bash
cloudflared tunnel login
cloudflared tunnel create wedding
# Map a hostname to the local app (adjust to your chosen subdomain):
cloudflared tunnel route dns wedding rsvp.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: wedding
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: rsvp.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel run wedding   # or install as a service: cloudflared service install
```

> The tunnel credentials JSON and `config.yml` are secrets — they are gitignored
> and must never be committed.

## 4. Protect /admin with Cloudflare Access

Cloudflare Zero Trust → Access → Applications → Add a **self-hosted** app:

- Application domain: `rsvp.example.com`, path: `/admin`
- (Add a second app for `/api/admin` if you want the APIs gated too.)
- Policy: **Allow** when *Emails* is one of your addresses (you + partner).
- Identity: the built-in **One-time PIN** works with no extra setup.

The allow-list of permitted emails lives **in the Cloudflare dashboard, not in
this repo**. Visitors must pass the email-code gate before they can even reach
the app's own admin login.

## 5. Edge rate limiting (optional but recommended)

Cloudflare → Security → WAF → Rate limiting rules. Add a rule limiting requests
to `/api/lookup` and `/api/rsvp` (e.g. 30/min per IP). The app also rate-limits
these routes itself (keyed on `CF-Connecting-IP`) as defense in depth.

## 6. Backups

All data is one SQLite file (`data/wedding.db`). Back it up regularly:

```bash
npm run backup        # writes a consistent copy to data/backups/
```

Schedule it nightly (cron on Linux, Task Scheduler on Windows). For continuous
protection on Linux, consider [Litestream](https://litestream.io). Backups and
the live DB are gitignored.

## 7. Go live

1. Set `APP_BASE_URL=https://rsvp.example.com` (the real hostname) and
   `NODE_ENV=production` in `.env`, then restart — email links now point to the
   public site.
2. Log in at `/admin`, change the admin credentials, import your guest list, and
   send yourself a test broadcast before the real one.
