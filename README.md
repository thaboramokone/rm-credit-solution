# RM Credit Solutions (Pty) Ltd — backend & web app

A real, self-contained web app: Node.js server, JSON-file database,
password hashing, session auth, file uploads, and email delivery — with
**zero external npm packages**. That's deliberate: it means `npm install`
can never fail on some dependency mismatch on whatever host you deploy to,
and there's nothing here whose security you have to trust except Node's
own standard library.

## Before you do anything else

1. **Create the admin inbox.** Go to outlook.com → Create free account →
   `AdminRM@outlook.com` (or any address ending in `RM@outlook.com` — the
   admin login rule matches that suffix). Set your own password there;
   nobody else ever needs to know it.
2. **Read the security notes near the bottom of this file** before you let
   real customers use this with real ID numbers and bank details.

## Running it locally

```
cd backend
cp .env.example .env
# edit .env: set SMTP_USER / SMTP_PASS to the AdminRM@outlook.com account
node server.js
```

Then open `http://localhost:3000`. If you skip the `.env` setup, the app
still works end-to-end — OTP codes just get printed to the server's
console/logs instead of emailed, which is fine for testing.

No `npm install` step, on purpose — there's nothing to install.

## Deploying it for real

This app needs a host that keeps a **persistent disk** running (the
`data/` folder holds your customers and loan records as JSON files, and
`uploads/` holds the ID/bank-statement documents) — it can't run on a
purely serverless/stateless platform like plain Vercel, which wipes the
filesystem between requests.

**Render.com** (recommended, has a free tier for this):
1. Push this `backend/` folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: (leave blank — there's nothing to build)
4. Start command: `node server.js`
5. Add a **Disk** (Render's persistent storage) mounted at `/opt/render/project/src/data` and another at `.../uploads` — or simpler, mount one disk at the project root covering both.
6. Add environment variables from `.env.example` (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) — use your real `AdminRM@outlook.com` password.
7. Deploy. Render gives you a `https://your-app.onrender.com` URL — that's your public browser link.

**Railway.app** works the same way (persistent volume + environment
variables + `node server.js` as the start command).

**A basic VPS** (DigitalOcean, Linode, etc.) also works well — install
Node 18+, copy this folder over, put your `.env` in place, and run it
behind a process manager like `pm2` or a `systemd` service, with
Nginx/Caddy in front for HTTPS.

Whichever you pick, you'll end up with a real `https://...` link you can
share with anyone — that's the "browser link" this whole thing was built
to produce.

## What's actually in here

```
server.js            — HTTP server, routing, all API endpoints
lib/db.js             — JSON-file datastore with a write queue (safe concurrent writes)
lib/auth.js            — password hashing (scrypt) + session tokens
lib/mailer.js            — a small SMTP client (talks to Outlook directly, no nodemailer)
lib/uploads.js            — saves uploaded documents to disk under random filenames
lib/validators.js          — shared validation + the interest calculation (server is the source of truth)
lib/rateLimit.js            — basic per-IP throttling on auth endpoints
frontend-src/               — the React source for the web app
public/                       — the built frontend + this is what gets served
```

To rebuild the frontend after editing anything in `frontend-src/`, you'll
need `esbuild` (or any bundler) since this environment doesn't ship one —
`npx esbuild frontend-src/entry.jsx --bundle --outfile=public/app.js
--loader:.jsx=jsx --jsx=automatic --minify`, with `react` and `react-dom`
available in `frontend-src/node_modules`.

## Security notes — please actually read these

- **Passwords** are hashed with scrypt (never stored in plain text).
- **Sessions** are random opaque tokens, not JWTs — they can be revoked
  server-side and can't be forged.
- **Every loan/document action checks ownership** — a customer can only
  ever see or act on their own loans; this is enforced server-side, not
  just hidden in the UI.
- **Interest is always recalculated server-side** — the frontend shows a
  live estimate for the customer's benefit, but a tampered request can't
  change what actually gets charged.
- **Uploaded documents are never served as plain static files** — only an
  authenticated admin session can fetch them, via `/api/admin/documents/:id`.
- **Rate limiting** is basic (per-IP, in-memory) — enough to blunt casual
  abuse, not enough to stop a determined attacker. If this grows, put it
  behind a real WAF/rate-limiting layer (Cloudflare, etc.).
- **What's still missing for a real production lending business:**
  - Password reset ("forgot password") isn't built yet.
  - No audit log of who approved/declined what.
  - The JSON-file database is fine for a modest volume of applicants but
    doesn't scale the way a real database (Postgres, etc.) would, and
    doesn't give you the encryption-at-rest options a managed DB does.
  - **South Africa's National Credit Regulator (NCR)** requires
    registration for short-term credit providers — that's a legal/business
    step independent of this code, and worth sorting before taking real
    applications.

None of the above stops you from using this as a working prototype or
soft-launching with a handful of trusted customers — but treat it as a
solid foundation to keep building on, not a finished, audited financial
system.
