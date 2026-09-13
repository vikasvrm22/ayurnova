-- =============================================================
-- AyurVeda Store — Phase 8C migration: Customer Wishlist
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Additive only: one new table. Does not touch
-- any existing table/column.
--
-- Locked decisions this migration implements:
--   - Keyed by product_id, NOT variant_id - which pack size to buy is a
--     checkout-time choice, not something saved (same spirit as the cart,
--     which is keyed by variant_id for a different reason: it's an actual
--     purchase intent, whereas a wishlist is "I like this product").
--   - product_id is `on delete cascade` - a hard product delete (the
--     existing DELETE /api/admin/products/:id route) must never leave an
--     orphaned wishlist row pointing at nothing; the row simply disappears
--     along with the product, exactly like product_images/product_variants
--     already do via their own on-delete-cascade FKs to products.
--   - RLS mirrors Phase 6A's `addresses` table exactly (`customers manage
--     own addresses`, `for all using (auth.uid() = customer_id)`) - a
--     wishlist is the same category of customer-owned personal data.
-- =============================================================

create table wishlist_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (customer_id, product_id)
);
create index idx_wishlist_items_customer on wishlist_items(customer_id, created_at desc);

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — same convention as `addresses` (Phase 1): a
-- customer may select/insert/update/delete only their own rows. Defense
-- in depth only - the actual customer-facing API (server/src/routes/
-- wishlistPublic.js) always reads via the server's service-role key, same
-- as every other Phase 6A+ customer route, and enforces ownership again
-- itself at the query level.
-- -------------------------------------------------------------
alter table wishlist_items enable row level security;

create policy "customers manage own wishlist items" on wishlist_items
  for all using (auth.uid() = customer_id);
