-- =============================================================
-- AyurVeda Store — Phase 8A migration: Tax & Invoicing
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Additive only: new nullable columns on
-- products_variants/addresses/orders/order_items (every existing row
-- stays valid as-is - see each ALTER's own comment for why), a new
-- sequence + wrapper function for concurrency-safe invoice numbering, and
-- one new `invoices` table.
--
-- Locked Phase 8A business rule this migration exists to support: the
-- business is NOT GST-registered yet. Every tax-related column here is
-- nullable/zero-defaulted specifically so the app keeps working exactly
-- as before with tax = 0 everywhere until an admin turns on
-- gst_registered in the `tax_profile` settings key (server/src/services/
-- taxService.js) and fills in real HSN/rate data - nothing here assumes
-- or invents a tax rate, HSN code, or legal value.
-- =============================================================

-- -------------------------------------------------------------
-- PRODUCT_VARIANTS: admin-configurable HSN/SAC + GST rate. Nullable -
-- null is treated as "not yet configured" (0% tax) by taxService.js,
-- never a hardcoded fallback rate.
-- -------------------------------------------------------------
alter table product_variants add column if not exists hsn_code text;
alter table product_variants add column if not exists tax_rate_percent numeric(5,2)
  check (tax_rate_percent is null or (tax_rate_percent >= 0 and tax_rate_percent <= 100));

-- -------------------------------------------------------------
-- ADDRESSES: optional GSTIN (for a business/B2B buyer) and a STRUCTURED
-- state code alongside the existing free-text `state` (unchanged, still
-- required, still what every existing address/order display already
-- reads). `state_code` is validated in application code against the
-- fixed GST state/UT list in server/src/utils/gstStateCodes.js - Phase 8A
-- deliberately keeps that a small in-code constant rather than a new
-- reference table (nothing about it changes at runtime).
-- -------------------------------------------------------------
alter table addresses add column if not exists state_code text;
alter table addresses add column if not exists gstin text;

-- -------------------------------------------------------------
-- ORDERS: buyer GST detail + order-level tax snapshot. `billing_address`
-- mirrors the existing `shipping_address` jsonb-snapshot shape exactly;
-- null means "same as shipping" - the default for every existing order
-- and every new order that doesn't explicitly set a different billing
-- address, so this is fully backward-compatible by construction.
-- tax_mode/taxable_value/cgst/sgst/igst/tax_amount are all snapshotted
-- ONCE at order-creation time (server/src/routes/public.js) and never
-- recomputed later - the same "never trust a later config change to
-- rewrite history" discipline price_snapshot already has.
-- -------------------------------------------------------------
alter table orders add column if not exists billing_address jsonb;
alter table orders add column if not exists buyer_gstin text;
alter table orders add column if not exists place_of_supply_state_code text;
alter table orders add column if not exists tax_mode text check (tax_mode is null or tax_mode in ('inclusive', 'exclusive'));
alter table orders add column if not exists taxable_value numeric(10,2);
alter table orders add column if not exists cgst_amount numeric(10,2) not null default 0;
alter table orders add column if not exists sgst_amount numeric(10,2) not null default 0;
alter table orders add column if not exists igst_amount numeric(10,2) not null default 0;
alter table orders add column if not exists tax_amount numeric(10,2) not null default 0;

-- -------------------------------------------------------------
-- ORDER_ITEMS: per-line tax snapshot, same pattern as the existing
-- title_snapshot/price_snapshot columns - a later change to a variant's
-- HSN/tax rate must never alter what an already-placed order's invoice
-- shows.
-- -------------------------------------------------------------
alter table order_items add column if not exists hsn_code_snapshot text;
alter table order_items add column if not exists tax_rate_snapshot numeric(5,2);
alter table order_items add column if not exists taxable_value_snapshot numeric(10,2);
alter table order_items add column if not exists cgst_amount_snapshot numeric(10,2) not null default 0;
alter table order_items add column if not exists sgst_amount_snapshot numeric(10,2) not null default 0;
alter table order_items add column if not exists igst_amount_snapshot numeric(10,2) not null default 0;

-- -------------------------------------------------------------
-- INVOICE NUMBERING — a plain Postgres sequence. Concurrency-safe by
-- construction (Postgres guarantees no two concurrent callers ever
-- receive the same nextval), and deliberately NOT gapless: a call that
-- allocates a number and then fails before the invoice row is inserted
-- (e.g. a transient DB error) leaves a permanent, harmless gap - the
-- locked scope explicitly does not require gapless numbering. The
-- prefix/zero-padding shown to humans is applied in application code
-- (server/src/services/invoiceService.js) from the admin-configured
-- `tax_profile` setting, never baked into the sequence itself, so
-- changing the prefix later never requires touching this sequence.
-- -------------------------------------------------------------
create sequence if not exists invoice_number_seq start 1;

create or replace function next_invoice_sequence_number()
returns bigint as $$
  select nextval('invoice_number_seq');
$$ language sql;

-- -------------------------------------------------------------
-- INVOICES — one row per issued invoice. 1:1 with orders in Phase 8A
-- (unique(order_id) below) - credit notes are explicitly out of scope for
-- this phase (locked rule #7); a future phase can extend `status` (e.g.
-- add 'credit_note') and relax this uniqueness without touching any
-- existing row's shape. Every seller/buyer/tax/line-item value is stored
-- as its own frozen snapshot (jsonb for structured groups) so the
-- invoice is self-contained and never depends on live product/settings/
-- order-item state remaining unchanged after it's issued.
-- -------------------------------------------------------------
create table invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  invoice_number text not null,
  sequence_number bigint not null,
  status text not null default 'issued' check (status in ('issued', 'cancelled')),
  tax_mode text not null check (tax_mode in ('inclusive', 'exclusive')),
  place_of_supply_state_code text,
  seller_snapshot jsonb not null,
  buyer_snapshot jsonb not null,
  line_items jsonb not null,
  subtotal numeric(10,2) not null,
  discount_amount numeric(10,2) not null default 0,
  shipping_amount numeric(10,2) not null default 0,
  taxable_value numeric(10,2) not null default 0,
  cgst_amount numeric(10,2) not null default 0,
  sgst_amount numeric(10,2) not null default 0,
  igst_amount numeric(10,2) not null default 0,
  tax_amount numeric(10,2) not null default 0,
  grand_total numeric(10,2) not null,
  generated_by text not null,
  created_at timestamptz not null default now(),
  unique (order_id),
  unique (invoice_number)
);
create index idx_invoices_created on invoices(created_at desc);

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — same convention as every Phase 2+ operational
-- table (payments/webhook_events/return_requests/notification_log/
-- legal_pages): no public policies. Only the service-role key (used
-- exclusively by the Express server) can reach this table; both admin
-- and customer invoice access are ownership/RBAC-checked in application
-- code (server/src/routes/invoicesAdmin.js and the invoice sub-routes on
-- server/src/routes/orderDetailPublic.js), matching every other
-- permission in this schema.
-- -------------------------------------------------------------
alter table invoices enable row level security;
