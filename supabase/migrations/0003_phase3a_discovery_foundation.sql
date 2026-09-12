-- =============================================================
-- AyurVeda Store — Phase 3A migration: Discovery & Knowledge data foundation
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- supabase/schema.sql and 0002_phase2_payments_and_integrations.sql:
-- Dashboard -> SQL Editor -> New query -> paste this whole file -> Run).
--
-- Purely additive: creates new tables and widens one existing check
-- constraint. Does not drop, rename, or modify any existing column or
-- row. Safe to run on the live database - no existing data is touched.
--
-- Implements the decisions locked in docs/AYURVEDICSTORE-PHASE-3-DECISIONS.md
-- (decision #1): `products.category_id` is INTENTIONALLY left unchanged -
-- it stays the product's single `product_type` category (Tablet/Oil/
-- Churna/Syrup - genuinely single-valued). Concern, Benefit and Goal are
-- naturally multi-valued per product, so they move to the many-to-many
-- join tables below instead of overloading the single `category_id` FK.
-- Schema/data foundation only - no admin UI, public UI, API routes,
-- search, or comparison logic in this migration (Phase 3B+).
-- =============================================================

-- -------------------------------------------------------------
-- CATEGORIES: widen `type` to add 'goal' (Benefit = what the product does;
-- Goal = what the shopper is trying to achieve - decision #2). Existing
-- 'concern' / 'benefit' / 'product_type' rows and every row using them
-- remain valid as-is; this only adds 'goal' to the allowed set.
-- -------------------------------------------------------------
alter table categories drop constraint if exists categories_type_check;
alter table categories add constraint categories_type_check
  check (type in ('concern', 'benefit', 'product_type', 'goal'));

-- Content fields so a concern/benefit/goal slug can back a real landing
-- page instead of only filtering the shop grid. All nullable - existing
-- rows (today, only the DEV-harness diagnostic fixture) remain valid.
alter table categories add column if not exists description text;
alter table categories add column if not exists hero_image text;
alter table categories add column if not exists seo_title text;
alter table categories add column if not exists seo_description text;

-- -------------------------------------------------------------
-- INGREDIENTS - a structured entity (previously only a free-text
-- `products.ingredients` column, which is left untouched: it remains the
-- human-written "full ingredient list" copy shown on the product page;
-- this table is the separate, structured set of ingredients a product can
-- be tagged with/discovered by).
-- -------------------------------------------------------------
create table ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- PRODUCT <-> INGREDIENT / CONCERN / BENEFIT / GOAL — many-to-many join
-- tables. Concern/Benefit/Goal reference the existing shared `categories`
-- table (same table `products.category_id` already points at for
-- `product_type` today), constrained by `type` at the application layer -
-- the same pattern `catalogService.js`'s `resolveCategoryId(slug, type)`
-- already uses for the existing single-FK `?concern=`/`?benefit=` filters,
-- since Postgres has no partial-FK to enforce a `type` value in the DB
-- layer itself.
--
-- Composite uniqueness on (product_id, related_id) is both the "no
-- duplicate relationship" guard and the join tables' primary access path;
-- a secondary index on the second column supports the reverse lookup
-- (e.g. "every product tagged with this concern").
-- -------------------------------------------------------------
create table product_ingredients (
  product_id uuid not null references products(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, ingredient_id)
);
create index idx_product_ingredients_product on product_ingredients(product_id);
create index idx_product_ingredients_ingredient on product_ingredients(ingredient_id);

create table product_concerns (
  product_id uuid not null references products(id) on delete cascade,
  concern_id uuid not null references categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, concern_id)
);
create index idx_product_concerns_product on product_concerns(product_id);
create index idx_product_concerns_concern on product_concerns(concern_id);

create table product_benefits (
  product_id uuid not null references products(id) on delete cascade,
  benefit_id uuid not null references categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, benefit_id)
);
create index idx_product_benefits_product on product_benefits(product_id);
create index idx_product_benefits_benefit on product_benefits(benefit_id);

create table product_goals (
  product_id uuid not null references products(id) on delete cascade,
  goal_id uuid not null references categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, goal_id)
);
create index idx_product_goals_product on product_goals(product_id);
create index idx_product_goals_goal on product_goals(goal_id);

-- -------------------------------------------------------------
-- FAQS — nullable `product_id`: NULL = global/site FAQ, set = that
-- product's own FAQ. One table serves both scopes (decision #3), matching
-- the existing nullable-FK pattern already used elsewhere in this schema
-- (e.g. `orders.customer_id` nullable for guest checkout).
-- -------------------------------------------------------------
create table faqs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  question text not null,
  answer text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_faqs_product on faqs(product_id) where product_id is not null;

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — same convention as products/product_variants/
-- categories: public (anon) read-only access, no status gating at the
-- join-table level (matching `product_images`/`product_variants`'s
-- existing `using (true)` policies - this app's storefront always reads
-- through the server's own published-product-filtered queries; RLS here
-- is the second line of defense for anything the anon key reaches
-- directly, same stated purpose as every other table's RLS in this
-- schema). Writes stay service-role-only (server-side, RBAC-gated in
-- application code), same as every other admin-managed table.
-- -------------------------------------------------------------
alter table ingredients enable row level security;
alter table product_ingredients enable row level security;
alter table product_concerns enable row level security;
alter table product_benefits enable row level security;
alter table product_goals enable row level security;
alter table faqs enable row level security;

create policy "public read ingredients" on ingredients
  for select using (true);
create policy "public read product ingredients" on product_ingredients
  for select using (true);
create policy "public read product concerns" on product_concerns
  for select using (true);
create policy "public read product benefits" on product_benefits
  for select using (true);
create policy "public read product goals" on product_goals
  for select using (true);
create policy "public read faqs" on faqs
  for select using (true);
