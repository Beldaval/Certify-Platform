# Certify — Certificate Generation & Delivery Platform (Phase 1)

A ready-to-deploy build matching the approved BRD/FRD: Netlify (static frontend +
serverless functions), Supabase (Postgres + Auth + Storage), Paystack (token
wallet top-ups), Gmail SMTP (delivery). No build step — this is uploaded to
Netlify as-is.

## ⚠️ Rotate your keys first

Your FRD document has the Supabase service role key, Paystack test secret key,
and Gmail app password written in plain text. Because that document has
already been shared/stored outside a locked-down location, **treat those three
credentials as compromised**:

1. Supabase → Project Settings → API → regenerate the `service_role` key
2. Paystack → Settings → API Keys & Webhooks → regenerate the secret key
3. Google Account → Security → App Passwords → revoke the old one, generate a new one

None of these three ever need to live in a document again — this build reads
them only from Netlify's environment variables (server-side only, never sent
to the browser). Delete or lock down the FRD once you've rotated the keys.

## What's included

```
public/               static frontend — this is what Netlify serves
  index.html             landing page + public certificate verification
  login.html              sign up / log in / password reset
  dashboard.html          template picker, batch builder, top-up, live status
  admin.html               admin-only: manual token credit, bulk email export
  assets/templates/      your 8 certificate SVGs
  assets/templates.json  field definitions per template
  js/config.js            ⚠️ EDIT THIS — public Supabase URL + anon key
netlify/functions/     serverless backend (Node.js)
  create-batch.js          validates + atomically deducts tokens, writes rows
  generate-batch-background.js   renders + emails a batch (background function)
  paystack-initialize.js  paystack-verify.js  paystack-webhook.js
  verify-certificate.js   public lookup — returns only safe fields
  admin-export-emails.js  admin-manual-credit.js
  download.js              signed URLs / zip download
  templates-list.js
  lib/                     shared helpers (Supabase client, SVG->PDF render, mailer)
supabase/schema.sql    run this once in the Supabase SQL editor
scripts/               one-time setup scripts (seed templates, create storage bucket)
netlify.toml           Netlify config (functions dir, redirects, headers)
.env.example           names of the env vars Netlify needs — no real values
```

## Deploy steps

### 1. Supabase project
You already have one under Beldaval Global Resources Ltd. In it:
1. SQL Editor → paste the full contents of `supabase/schema.sql` → Run.
2. From a terminal with Node installed, **temporarily** export your (rotated)
   service role key and run the two setup scripts once:
   ```
   npm install
   export SUPABASE_URL=https://your-project-ref.supabase.co
   export SUPABASE_SERVICE_ROLE_KEY=your-new-service-role-key
   node scripts/setup-storage-bucket.js
   node scripts/seed-templates.js
   ```
   Then close that terminal / unset the variables — don't leave the key sitting
   in your shell history longer than needed (`history -c` if you're on bash).
3. Authentication → Providers → confirm Email is enabled. Authentication →
   URL Configuration → set your Netlify site URL as a redirect URL (needed for
   password reset links).
4. To make your own account an admin (for `/admin.html`): Table editor →
   `profiles` → find your row → set `is_admin` to `true`.

### 2. Paystack
Nothing to configure in the code beyond env vars. In the Paystack dashboard,
add a webhook URL once your site is live:
`https://YOUR-SITE.netlify.app/.netlify/functions/paystack-webhook`

### 3. Gmail
Use an **App Password** (Google Account → Security → 2-Step Verification →
App Passwords), never your real Gmail password. Gmail SMTP caps out around
500 sends/day — fine for Phase 1, flagged as a known constraint in the FRD.

### 4. Edit the one public-safe config file
Open `public/js/config.js` and fill in:
```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://your-project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-public-key',   // safe to expose — see comment in file
  PAYSTACK_PUBLIC_KEY: 'pk_test_...',          // or pk_live_... at launch
};
```
This is the **only** file you edit before uploading. Everything else (secret
keys) is set in Netlify's dashboard in the next step, never in a file.

### 5. Deploy to Netlify (drag-and-drop, no Git needed)
1. Zip up this whole folder (or use the zip you were given).
2. Netlify → **Add new site → Deploy manually** → drag the zip in.
3. Once it's created, go to **Site settings → Environment variables** and add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | your **rotated** service role key |
   | `PAYSTACK_SECRET_KEY` | your **rotated** Paystack secret key |
   | `GMAIL_USER` | your Gmail address |
   | `GMAIL_APP_PASSWORD` | your **rotated** Gmail app password |
   | `SENDER_NAME` | `Certify` (or your org name) |
   | `PUBLIC_SITE_URL` | `https://your-site.netlify.app` |

4. Trigger a redeploy (Deploys → Trigger deploy) so functions pick up the new
   env vars.
5. Test end-to-end with Paystack **test** keys first: sign up, confirm the 500
   trial tokens appear, generate a small batch, top up with a Paystack test
   card, confirm tokens credit, then switch `PAYSTACK_SECRET_KEY` and
   `PAYSTACK_PUBLIC_KEY` to live keys only once that's all working.

## Netlify plan requirement — read before relying on 50-certificate batches

`generate-batch-background.js` uses Netlify's **Background Functions**
(the `-background` suffix), which get up to 15 minutes instead of the ~10
second limit on normal functions — needed for a 50-certificate batch with
paced emails. Background Functions are available on paid Netlify plans; on
the free tier, large batches may time out partway through. If that happens on
your plan, the safest fallback is capping batch size lower (e.g. 10–15) until
you upgrade, rather than losing partial batches — check your current Netlify
plan's function limits before promising customers the full 50.

## Security architecture — what enforces what

- **Secrets** (Supabase service role, Paystack secret, Gmail app password)
  only ever exist as Netlify server-side environment variables, read inside
  `netlify/functions/*`. Nothing under `/public` references them.
- **Row Level Security** in `supabase/schema.sql` means even if someone got
  the public anon key (which is meant to be public), they still can't read
  another user's certificates, wallet, or payment history directly — Postgres
  enforces it, not just the UI.
- **Public verification** (`verify-certificate.js`) hand-picks exactly four
  safe columns to return. Token, payment, email, and account data are
  structurally unreachable through that endpoint.
- **Payments** are never trusted from the browser: both the webhook and the
  client-triggered fallback re-verify the transaction directly against
  Paystack's API before crediting tokens, and crediting is idempotent per
  payment reference so a retried webhook can't double-credit.
- **Downloads** are short-lived signed URLs (10 minutes), not permanent links.
- **Admin actions** (manual token credit, bulk email export) check
  `profiles.is_admin` server-side on every call.

## Known simplifications vs. the full FRD (flagged honestly)

- **Email pacing** uses a fixed 3-second delay between sends rather than a
  more adaptive scheme — adjust `EMAIL_PACING_MS` in
  `generate-batch-background.js` if Gmail starts flagging sends.
- **CSV bulk upload, QR verification, and a dedicated transactional email
  API** are explicitly out of scope for Phase 1 per the BRD/FRD and aren't
  built here either.
- This is a first working build, not a fully hardened production system —
  test the full flow (signup → trial tokens → batch → payment → email →
  verification → admin) with Paystack test keys before pointing real church
  administrators at it.
