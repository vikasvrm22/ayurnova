# AyurVeda Store — Full Project (Supabase edition)

A complete Ayurveda ecommerce platform: product catalog with pack-size
variants, cart & checkout, Consult-a-Vaidya bookings, a Dosha quiz, and a
full admin back-office — all backed by Supabase (Postgres + Auth + Storage).

## What's in here

```
ayur-app/
├── supabase/
│   └── schema.sql     Run this once in your Supabase project's SQL Editor
├── server/            Node.js/Express API + SSR page renderer
├── admin/              Admin panel (plain HTML/JS, no build step)
└── public-site/        The storefront templates (server-rendered per request)
```

## Quick start

**Read `SETUP.md` first** — you need a free Supabase project before anything
else will work.

```bash
cd server
npm install
npm run seed-admin   # creates your first Super Admin login
npm start
```
Then open:
- Admin panel: `http://localhost:4000/admin`
- Storefront: `http://localhost:4000/`

## What this build includes

| Area | Details |
|---|---|
| **Product catalog** | Title, brand, category, descriptions, ingredients, how-to-use, multiple images (Supabase Storage), multiple pack-size variants (price/MRP/stock each) |
| **Storefront** | Homepage, Shop listing (category filters), Product detail (gallery, pack selector, tabs, reviews), Cart, Checkout (COD or prepaid-placeholder), Consult-a-Vaidya booking form, Dosha quiz, About, Contact, Account (Supabase Auth login/signup + order history) |
| **Admin panel** | Dashboard (revenue/orders/top-products + visit analytics chart), Products (full CRUD incl. images/variants), Orders (status workflow), Customers, Coupons, Reviews (moderation), Vaidya Bookings, Blog, Users & Roles (RBAC), Settings (trust badges, shipping, upload limits, social links) |
| **SEO** | Server-side rendering, Product/BreadcrumbList JSON-LD, sitemap.xml, clean URLs |
| **Security** | helmet, rate limiting, bcrypt + JWT admin auth, Supabase Auth + RLS for customers, server-side validation everywhere |
| **Cost controls** | 5-minute SSR cache (fewer DB reads per pageview), trimmed-column queries, automatic WebP image compression to a target size on every upload, gzip compression |

## Known gaps / what you still need to wire up yourself

- **Payment gateway**: checkout supports COD fully; "Prepaid" is a placeholder
  — plug Razorpay/PayU into `server/src/routes/public.js`'s checkout route
  and `public-site/cart.html`'s checkout script (see SETUP.md).
- **Order confirmation emails/SMS**: not wired up — add your SMTP/SMS
  provider call where noted in `public.js`.
- **Email confirmation for signup**: handled by Supabase Auth's default
  email templates — customize those in your Supabase dashboard
  (Authentication → Email Templates) if you want your own branding.
- **CSV export** buttons are placeholders (not wired to real exports yet).

## Support

Every route fails loudly and specifically (validation errors name the
field; auth errors say which permission was missing) — check the browser
console and the server log first; they usually point straight at the cause.
