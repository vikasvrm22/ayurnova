# SETUP.md — Getting the AyurVeda Store running

## Part 1: Create your Supabase project (required)

1. Go to https://supabase.com, sign up (free), and create a **New Project**.
   Pick any name/region/password (save the DB password somewhere safe).
2. Once it's ready, go to **SQL Editor** (left sidebar) → **New query**.
3. Open `supabase/schema.sql` from this project, copy the **entire file**,
   paste it into the SQL editor, and click **Run**. This creates every
   table, security policy, and default settings row.
4. Go to **Storage** (left sidebar) → **Create a new bucket**:
   - Name: `product-images` (must match `SUPABASE_STORAGE_BUCKET` in `.env`)
   - Public bucket: **Yes** (so product images load on the storefront)
5. Go to **Settings → API** and copy three values:
   - **Project URL** → `SUPABASE_URL`
   - **anon / public key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (click "Reveal" - keep this secret)

## Part 2: Configure the server

```bash
cd server
cp .env.example .env
```
Open `.env` and fill in the three Supabase values from above, plus:
```
JWT_SECRET=<any long random string>
SITE_BASE_URL=http://localhost:5100
```
(`PORT` defaults to 5100 - chosen to stay clear of other common local dev
defaults like 3000/8000 on a shared machine. Change it in `.env` if 5100 is
already taken on your machine too; nothing else hardcodes it.)

Then:
```bash
npm install
npm run seed-admin
```
This prints your first Super Admin login (from `SEED_SUPERADMIN_EMAIL` /
`SEED_SUPERADMIN_PASSWORD` in `.env`, or the defaults if you didn't change
them). **Change that password immediately** after logging in (Admin panel →
sidebar → Change Password).

```bash
npm start
```
Visit `http://localhost:5100/admin` to log in, and `http://localhost:5100/`
for the storefront.

## Part 3: Add your first product

1. Log into the admin panel → **Products → + Add Product**.
2. Fill in the title, description, etc. → **Save Changes** (this creates the
   product as a Draft and unlocks image/variant uploads).
3. Add at least one **Pack Size Variant** (label + price + stock) — a
   product with no variants can't be added to cart.
4. Upload one or more images.
5. Click **Publish** — it now appears on the live storefront.

## Part 4: Customer accounts (Supabase Auth)

Customer signup/login on `/account` uses **Supabase Auth** directly from
the browser — no extra setup needed, it works out of the box with the
`SUPABASE_ANON_KEY` already in your `.env`. Two things worth knowing:

- By default, Supabase requires email confirmation before a new signup can
  log in. To customize the confirmation email, go to **Authentication →
  Email Templates** in your Supabase dashboard. To disable confirmation
  entirely for faster testing, go to **Authentication → Providers → Email**
  and turn off "Confirm email" (not recommended for a real launch).
- Admin/staff logins are **completely separate** (their own `staff_users`
  table, JWT-based) - a customer account can never access the admin panel,
  and vice versa.

## Part 5: Payment gateway (placeholder - you need to wire this up)

Checkout currently supports:
- **COD (Cash on Delivery)** — fully working, no setup needed.
- **Prepaid** — applies the prepaid discount and creates the order marked
  `unpaid`, but does **not** actually charge a card yet. To go live with
  real payments:

1. Sign up for **Razorpay** (https://razorpay.com) or **PayU** — India's
   most common gateways, both support UPI/cards/netbanking.
2. Get your API keys (test mode first, then live mode after KYC approval).
3. In `server/src/routes/public.js`'s `/checkout` route, after the order is
   created with `payment_method: "prepaid"`, create a payment order with
   your gateway's SDK and return its checkout URL/token to the frontend.
4. In `public-site/cart.html`'s checkout script, redirect to that gateway
   checkout page (or open their embedded widget) instead of immediately
   showing "Order Placed".
5. Add a webhook endpoint (e.g. `POST /api/public/payment-webhook`) that
   the gateway calls on successful payment - update `orders.payment_status`
   to `paid` there.

This is a meaningful chunk of integration work specific to whichever
gateway you choose - happy to help wire up the actual code once you've
picked one and have test-mode API keys.

## Part 6: Order notifications (not wired up)

There's no email/SMS sent when an order is placed or its status changes.
Add your own provider call in `server/src/routes/public.js` (after order
creation) and `server/src/routes/orders.js` (after a status update) - e.g.
using Resend/SendGrid for email or an SMS gateway like MSG91/Twilio for
India.

## Part 7: Keeping hosting costs low

A few things in this build specifically help keep a Railway/Render bill
small for a low-to-medium traffic store:

- **Automatic image compression**: every uploaded product image is
  converted to WebP and compressed to a target size (default 200KB,
  configurable in Admin → Settings → Uploads) using the `sharp` library -
  this happens automatically on upload, no manual compression needed.
  Note: `sharp` ships prebuilt binaries for Linux/macOS/Windows, so
  `npm install` on Railway/Render just works - no extra build step needed.
- **SSR page cache** (`SSR_CACHE_TTL_MS`, default 5 minutes): rendered
  pages are served from memory instead of re-querying Supabase on every
  single visit. Raising this further (e.g. to 15-30 minutes) cuts database
  reads even more, at the cost of a freshly published product taking longer
  to appear. Lower it if you publish very frequently.
- **Trimmed queries**: listing pages (homepage, shop) only select the
  columns they actually render, not every column - smaller payloads, less
  work per request.
- **Automatic image compression** (Admin → Settings → Uploads): every
  uploaded product image is converted to WebP and compressed down to a
  target size (default 200KB) automatically on the server - the admin
  doesn't need to compress anything themselves before uploading. Adjust
  the target size or the max original file size accepted from Settings.
- **gzip compression** is already on for every response.

### Realistic monthly cost estimate (Railway Hobby plan, low-medium traffic)
- Railway hosting: **$5/month** (base plan, usually enough at this scale)
- Supabase: **$0** while you're within the free tier (500MB database,
  1GB file storage, 2GB bandwidth/month) - upgrade to Supabase Pro
  ($25/month) only once you outgrow that
- Domain: **~₹500-1500/year**, bought from any registrar (Namecheap, etc.)

## Part 8: Deploying (Railway example)

1. Push this project to a GitHub repo.
2. On Railway: **New Project → Deploy from GitHub repo**, select it, and
   set the **root directory** to `server/`.
3. Add all the same environment variables from your `.env` file in
   Railway's **Variables** tab (never commit `.env` to git).
4. Set `SITE_BASE_URL` to your real domain once you have one.
5. Railway builds and starts the app automatically (`npm start`). Point
   your domain's DNS at the URL/CNAME Railway gives you.
6. The `admin/` and `public-site/` folders are served by the same Express
   server (no separate hosting needed for them).
