-- =============================================================
-- AyurNova — Phase UI-1 migration: Admin Banners & Media
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Additive only: one new table. Does not touch
-- any existing table/column.
--
-- Why this exists: the Phase UI-1 admin reference design includes a
-- "Banners & Media" section with no existing backend to back it (the only
-- prior image-upload path was per-product). This is a small, generic media
-- library: each row is one uploaded image, optionally pinned to a
-- `placement` key (e.g. "home_hero") that a customer-facing page can look
-- up by. `active` lets an admin swap which asset serves a placement
-- without deleting history; only the products/hero rendering paths that
-- explicitly opt in to reading a placement are affected - nothing is
-- forced onto an existing page.
-- =============================================================

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  placement text, -- e.g. 'home_hero'; null = general library asset, not bound to any page slot
  url text not null,
  storage_path text not null, -- bucket-relative path, needed to delete the underlying object
  width int,
  height int,
  size_bytes int,
  format text,
  active boolean not null default true,
  source_note text, -- e.g. "cropped from Phase1 01 Home.png reference" - asset provenance, admin-facing only
  uploaded_by uuid references staff_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_media_assets_placement on media_assets(placement, active);

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — admin writes go through the server's service-role
-- key (same convention as every other admin-managed table), so no INSERT/
-- UPDATE/DELETE policy is needed here. Only public SELECT is opened, and
-- only for active rows, so the customer-facing homepage can read a
-- placement's current asset directly if a future public read ever needs
-- to bypass the service role - matching the read-only public policies on
-- categories/product_images above.
-- -------------------------------------------------------------
alter table media_assets enable row level security;

create policy "public read active media assets" on media_assets
  for select using (active = true);
