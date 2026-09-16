# دعوات — Backend

Turns the static landing page into a working system: a lead form on the
site feeds an admin dashboard, each order gets an auto-generated invitation
page once you fill in the details, and guests can RSVP for real (featured
plan).

## What this does (and doesn't) automate

- **Fully automatic:** once you (the admin) enter a couple's names, date,
  venue, plan and pick one of the 7 styles, the public invitation page
  (`/invite/<slug>`) is generated instantly — countdown timer, RSVP form
  (featured plan), location map, and a branded link preview for WhatsApp,
  all live. No coding per order.
- **Still manual, on purpose:** producing the actual AI opening video for
  each couple. Upload the finished video file (or paste an external URL)
  on the order's page and it appears on their invitation page
  automatically. If you later get a pipeline that generates that video
  automatically, this is the one step you'd wire up — everything else
  is already automatic.

## Project layout

```
dawaat/
  server.js             Express app — all routes
  db.js                  SQLite schema (auto-creates data/dawaat.db)
  lib/slug.js             Random link-code generator
  scripts/hash-password.js   Generates the admin password hash
  scripts/generate-secret.js Generates the session secret
  views/                 Admin pages + the public invitation page (EJS)
  public/landing.html    Your landing page (order form wired up)
  public/og/             Branded link-preview images (one per style)
  public/videos/         The door-opening intro video shown on /demo templates
  public/uploads/videos/ Videos uploaded per order via /admin (not in Git)
  data/                  SQLite database file lives here (created on first run)
  .env.example           Copy to .env and fill in
```

## How orders flow

1. A couple fills the "اطلبوا دعوتكم" form on the landing page, **or**
   messages you on WhatsApp as before.
2. Either way, you open `/admin`, see the order (form submissions appear
   automatically; WhatsApp conversations you add yourself via
   "+ طلب جديد").
3. You fill in the couple's details, pick a style, mark it `paid` once
   they've paid.
4. Upload the opening video for that order (or paste an external URL) —
   it's optional; without one the invitation just opens straight to the
   details. (Demo/template pages always show a default door-opening
   intro instead — that one's just for showing off the effect before
   anyone orders.)
5. When the invitation is ready, you get the shareable link right there
   on the order page and copy it to send to the couple. Mark the order
   `published`.
6. Guests RSVP on the page itself; responses land in the order's RSVP
   list in real time, and you can export them as a CSV for the venue or
   caterer headcount.

## Running it locally

```bash
cd dawaat
npm install
cp .env.example .env

# Generate your admin password hash and paste it into .env as ADMIN_PASSWORD_HASH
node scripts/hash-password.js "yourNewPassword"

# Generate a session secret and paste it into .env as SESSION_SECRET
node scripts/generate-secret.js

# Edit .env — fill in ADMIN_USERNAME, WHATSAPP_NUMBER, BASE_URL, etc.
npm start
```

Visit `http://localhost:3000` for the landing page and
`http://localhost:3000/admin` for the dashboard. The server prints a
warning on startup if the password hash or session secret are missing.

**Changing the admin password later:** just re-run
`node scripts/hash-password.js "newPassword"` and replace
`ADMIN_PASSWORD_HASH` in `.env`, then restart the server.

## Deploying to your VPS (avenocode.com)

1. **Copy the `dawaat` folder to your VPS**, e.g. via `scp` or `git`.
2. **Install Node.js** on the VPS if it isn't already there (Node 18+).
3. Inside the folder:
   ```bash
   npm install --production
   cp .env.example .env
   node scripts/hash-password.js "yourNewPassword"   # paste result into .env
   node scripts/generate-secret.js                    # paste result into .env
   nano .env   # fill in the rest — ADMIN_USERNAME, WHATSAPP_NUMBER, BASE_URL, etc.
   ```
   Make sure `NODE_ENV=production` is set in `.env` once you're behind
   HTTPS — it turns on the `secure` flag on the admin session cookie. On
   plain HTTP (e.g. testing before Certbot is set up) leave it unset, or
   the browser will silently refuse to send the cookie back.
4. **Keep it running** with a process manager so it survives reboots and
   crashes:
   ```bash
   npm install -g pm2
   pm2 start server.js --name dawaat
   pm2 save
   pm2 startup   # follow the printed instructions once
   ```
5. **Put it behind Nginx** on a subdomain (recommended so it doesn't
   collide with anything else on avenocode.com), e.g. `dawaat.avenocode.com`.
   Note the added `client_max_body_size` — needed for video uploads:
   ```nginx
   server {
       listen 80;
       server_name dawaat.avenocode.com;
       client_max_body_size 100M;

       location / {
           proxy_pass http://localhost:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
   Point a DNS `A` record for `dawaat` at your VPS's IP, then reload
   Nginx (`sudo nginx -t && sudo systemctl reload nginx`).
6. **Add HTTPS** with Certbot (free, does the Nginx config for you):
   ```bash
   sudo certbot --nginx -d dawaat.avenocode.com
   ```
7. Set `BASE_URL=https://dawaat.avenocode.com` in `.env` and restart:
   `pm2 restart dawaat`. This is the URL used to build the shareable
   invitation links AND the WhatsApp link-preview images, so it must be
   the real public HTTPS domain for the preview images to load.

## Per-order music and stickers

From an order's admin page you can optionally upload:

- **Background music** — one audio file for that invitation, played via a
  small toggle button (browsers block autoplay-with-sound, so a guest has
  to tap it once; volume fades in smoothly after that).
- **Background stickers** — a small set of images that fade in and drift
  slowly in the page background while a guest scrolls.

Both are entirely optional and scoped to that one order — an order with
nothing uploaded shows no music and no stickers, regardless of what other
orders have set. There's no site-wide/global version of either.

## Backing up

Run `npm run backup` — it copies `data/dawaat.db` (via SQLite's safe online
backup API, so it's fine to run while the server is up) and all of
`public/uploads/` into a timestamped folder under `backups/`, then deletes
backups older than 14 days (override with `BACKUP_RETENTION_DAYS` in `.env`).

To run it automatically, add a daily cron entry on your VPS:
```bash
crontab -e
# add this line (3am daily, logs to backups/backup.log):
0 3 * * * cd /path/to/dawaat && npm run backup >> backups/backup.log 2>&1
```
For real disaster recovery, also copy the `backups/` folder itself off the
server periodically (rsync to another machine, or sync to cloud storage) —
a backup that lives on the same disk as the original doesn't protect
against that disk failing.

## Security notes

- `/admin` is protected by a single username + bcrypt-hashed password —
  the plain password is never stored, only its hash in `.env`.
- Every admin form carries a session-bound CSRF token, checked on every
  state-changing request, so a malicious page elsewhere on the web can't
  submit admin actions using a logged-in admin's browser session.
- Login, the lead form, and the RSVP form are all rate-limited per IP to
  blunt brute-force and spam attempts.
- Both public forms include an invisible honeypot field — bots that fill
  in every field (including hidden ones) are silently ignored rather than
  saved.
- [Helmet](https://helmetjs.github.io/) sets baseline security headers
  (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS,
  etc.) on every response. Content-Security-Policy is intentionally left
  off, since the invitation/admin pages rely on inline scripts/styles
  throughout — adding a strict CSP would need a larger nonce-based rework.
- Always run it behind HTTPS in production (see Certbot step above), with
  `NODE_ENV=production` set, so the admin login and session cookie are
  never sent in the clear.
- If you ever want more than one admin login or stronger security
  (e.g. 2FA), that's a reasonable next step — flag it and it can be
  added without changing anything else.

## Continuous integration

`.github/workflows/test.yml` runs the full test suite (and a dependency
audit) on every push and pull request against `main`, via GitHub Actions.
It needs nothing configured — it just runs `npm ci && npm test` on a clean
checkout. If this project isn't pushed to GitHub yet, the workflow file is
harmless to keep around; it'll pick up automatically the first time it is.

## Link previews (Open Graph)

When someone shares an invitation link in WhatsApp, it now shows a
branded gold preview image plus the couple's names and event details —
one static image per style, in `public/og/`. This only works correctly
once `BASE_URL` in `.env` is set to your real public domain, since
WhatsApp fetches the image directly from that URL — it won't work
against `localhost`.
