-- =============================================================
-- AyurVeda Store — Supabase schema
-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste this whole file → Run)
-- =============================================================

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- STAFF / ADMIN USERS (separate from Supabase Auth customers -
-- the admin panel uses its own email+password login, same
-- pattern as a typical staff back-office, checked by the server)
-- -------------------------------------------------------------
create table staff_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text not null,
  password_hash text not null,
  role text not null check (role in ('SuperAdmin','Admin','Editor','Viewer')),
  status text not null default 'active' check (status in ('invited','active','deactivated')),
  setup_token text,
  created_at timestamptz not null default now(),
  invited_by text
);

-- -------------------------------------------------------------
-- CATEGORIES (used for both "Health Concern" and "Benefit" taxonomies)
-- -------------------------------------------------------------
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  type text not null check (type in ('concern','benefit','product_type')),
  sort_order int default 0,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- PRODUCTS
-- -------------------------------------------------------------
create table products (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique not null,
  brand text,
  category_id uuid references categories(id) on delete set null,
  short_description text,          -- bullet points, one per line
  description text,
  ingredients text,
  how_to_use text,
  seo_title text,
  seo_description text,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  avg_rating numeric(2,1) not null default 0,
  review_count int not null default 0,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_products_status on products(status);
create index idx_products_category on products(category_id);

create table product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  url text not null,
  sort_order int not null default 0
);

create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  label text not null,             -- e.g. "Pack of 60 Tablets"
  sku text,
  price numeric(10,2) not null,
  mrp numeric(10,2),
  stock int not null default 0,
  weight_grams int,
  sort_order int not null default 0
);
create index idx_variants_product on product_variants(product_id);

-- Atomic stock decrement (avoids a race condition between two simultaneous
-- checkouts both reading the same stock count before either writes back).
create or replace function decrement_variant_stock(variant_id uuid, qty int)
returns void as $$
begin
  update product_variants set stock = greatest(0, stock - qty) where id = variant_id;
end;
$$ language plpgsql;

-- -------------------------------------------------------------
-- REVIEWS (submitted by customers, moderated by staff)
-- -------------------------------------------------------------
create table reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  customer_id uuid references auth.users(id) on delete set null,
  customer_name text not null,
  rating int not null check (rating between 1 and 5),
  title text,
  body text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create index idx_reviews_product on reviews(product_id);
create index idx_reviews_status on reviews(status);

-- -------------------------------------------------------------
-- COUPONS
-- -------------------------------------------------------------
create table coupons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  discount_type text not null check (discount_type in ('percent','flat')),
  discount_value numeric(10,2) not null,
  min_order_value numeric(10,2) default 0,
  valid_from timestamptz,
  valid_until timestamptz,
  usage_limit int,
  used_count int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- ADDRESSES (customer shipping addresses)
-- -------------------------------------------------------------
create table addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  line1 text,
  line2 text,
  city text,
  state text,
  pincode text,
  is_default boolean default false,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- ORDERS
-- -------------------------------------------------------------
create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique not null,
  customer_id uuid references auth.users(id) on delete set null,
  guest_email text,
  guest_phone text,
  status text not null default 'pending' check (status in ('pending','processing','shipped','delivered','cancelled')),
  payment_method text not null check (payment_method in ('cod','prepaid')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded')),
  subtotal numeric(10,2) not null,
  shipping_fee numeric(10,2) not null default 0,
  discount numeric(10,2) not null default 0,
  total numeric(10,2) not null,
  coupon_code text,
  shipping_address jsonb not null,
  tracking_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_orders_customer on orders(customer_id);
create index idx_orders_status on orders(status);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  variant_id uuid references product_variants(id) on delete set null,
  title_snapshot text not null,
  variant_label_snapshot text,
  price_snapshot numeric(10,2) not null,
  qty int not null,
  subtotal numeric(10,2) not null
);
create index idx_order_items_order on order_items(order_id);

-- -------------------------------------------------------------
-- CONSULT-A-VAIDYA BOOKINGS
-- -------------------------------------------------------------
create table vaidya_bookings (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  email text,
  concern text,
  preferred_vaidya text,
  preferred_datetime timestamptz,
  description text,
  status text not null default 'pending' check (status in ('pending','confirmed','completed','cancelled')),
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- DOSHA TEST RESULTS (optional history, quiz itself runs client-side)
-- -------------------------------------------------------------
create table dosha_results (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete set null,
  answers jsonb not null,
  result_dosha text not null,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- BLOG
-- -------------------------------------------------------------
create table blog_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique not null,
  excerpt text,
  body text,
  cover_image text,
  status text not null default 'draft' check (status in ('draft','published')),
  seo_title text,
  seo_description text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- SETTINGS (key-value store: trust badges, social links, ad ids, etc.)
-- -------------------------------------------------------------
create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('trust_badges', '{"cod": true, "shipping": true, "return": true}'),
  ('shipping', '{"free_shipping_threshold": 599, "prepaid_discount_percent": 2}'),
  ('social_links', '{"telegram": "", "whatsapp_channel": "", "instagram": ""}'),
  ('uploads', '{"max_image_mb": 5, "target_kb": 200}')
on conflict (key) do nothing;

-- -------------------------------------------------------------
-- ANALYTICS: page views + admin activity audit trail
-- -------------------------------------------------------------
create table page_views (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  at timestamptz not null default now(),
  ip text,
  country text,
  region text,
  city text,
  user_agent text,
  referrer text
);
create index idx_pageviews_at on page_views(at);

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text,
  action text not null,
  actor text,
  note text,
  at timestamptz not null default now()
);

-- =============================================================
-- ROW LEVEL SECURITY
-- The Express server uses the SERVICE ROLE key for all admin
-- writes (which bypasses RLS entirely, same trust boundary as
-- the rest of this app's API-mediated design). RLS here exists
-- as a second line of defense for anything the ANON key can
-- reach directly (public product/category reads, and a
-- customer's own orders/reviews via their Supabase Auth session).
-- =============================================================
alter table products enable row level security;
alter table product_images enable row level security;
alter table product_variants enable row level security;
alter table categories enable row level security;
alter table reviews enable row level security;
alter table blog_posts enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table addresses enable row level security;
alter table settings enable row level security;
alter table coupons enable row level security;
alter table vaidya_bookings enable row level security;
alter table dosha_results enable row level security;
alter table page_views enable row level security;
alter table activity_log enable row level security;
alter table staff_users enable row level security;

-- Public (anon) read-only access to the live storefront catalog
create policy "public read published products" on products
  for select using (status = 'published');
create policy "public read product images" on product_images
  for select using (true);
create policy "public read product variants" on product_variants
  for select using (true);
create policy "public read categories" on categories
  for select using (true);
create policy "public read approved reviews" on reviews
  for select using (status = 'approved');
create policy "public read published blog posts" on blog_posts
  for select using (status = 'published');

-- Customers can see/manage only their own orders, addresses, reviews, bookings
create policy "customers view own orders" on orders
  for select using (auth.uid() = customer_id);
create policy "customers view own order items" on order_items
  for select using (exists (select 1 from orders o where o.id = order_items.order_id and o.customer_id = auth.uid()));
create policy "customers manage own addresses" on addresses
  for all using (auth.uid() = customer_id);
create policy "customers insert own reviews" on reviews
  for insert with check (auth.uid() = customer_id);

-- Everything else (settings, coupons details, staff_users, page_views,
-- activity_log, vaidya_bookings, dosha_results, and all WRITE access to
-- products/orders/etc.) has no public policy - only the service-role key
-- (used exclusively by the Express server) can reach it. This is
-- intentional: the admin panel never talks to Supabase directly.
