-- =============================================================
-- AyurVeda Store — Phase 6B migration: Returns & Refund Experience
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Additive: two new tables, one new column on
-- `orders`, and one new `settings` row. Reuses Phase 5A's
-- adjust_batch_quantity()/is_batch_sellable() UNCHANGED for QC-pending
-- returned-stock intake (see server/src/services/returnsService.js) -
-- deliberately does NOT touch or call restock_order() (Phase 5B), since a
-- return is not a cancellation: goods are physically coming back and must
-- clear QC before they can ever become sellable again.
-- =============================================================

-- -------------------------------------------------------------
-- orders.delivered_at — needed to compute "within 7 calendar days of
-- delivery" at all. `orders.updated_at` cannot be used for this: it gets
-- touched by any later edit (e.g. an admin correcting a tracking number
-- after delivery), which would silently reset a customer's return window.
-- Nullable, set exactly once - the first time status transitions to
-- 'delivered' (server/src/routes/orders.js), never overwritten again.
-- -------------------------------------------------------------
alter table orders add column delivered_at timestamptz;

-- -------------------------------------------------------------
-- RETURN_REQUESTS — one row per customer return submission (may cover
-- several order items at once, each with its own reason - see
-- return_request_items below). Lifecycle: requested -> approved/rejected
-- -> refunded. Refund tracking fields live directly on this row (a return
-- request has at most one refund outcome, so a join table would be pure
-- overhead) and cover BOTH paths: prepaid (via the existing
-- paymentService.createRefund(), refund_method='razorpay') and COD manual
-- tracking (refund_method in 'upi'/'bank_transfer', gated by the
-- cod_refund_enabled setting below). refund_reference/refund_notes are
-- staff-only - the customer-facing API never returns them (see
-- server/src/routes/returnsPublic.js's own field allowlist).
-- -------------------------------------------------------------
create table return_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  customer_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'refunded')),
  note text,
  rejection_reason text,
  refund_amount numeric(10, 2) check (refund_amount is null or refund_amount >= 0),
  refund_method text check (refund_method in ('razorpay', 'upi', 'bank_transfer')),
  refund_reference text,
  refund_status text not null default 'none' check (refund_status in ('none', 'completed', 'failed')),
  refund_processed_at timestamptz,
  refund_processed_by text,
  refund_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_return_requests_order on return_requests(order_id);
create index idx_return_requests_customer on return_requests(customer_id, created_at desc);
create index idx_return_requests_status on return_requests(status);

-- -------------------------------------------------------------
-- RETURN_REQUEST_ITEMS — one row per order_item being returned within a
-- request, with its own reason (fixed taxonomy only - damaged/leaked/
-- defective/wrong_product/expired/tampered/missing_item; deliberately
-- excludes change-of-mind/preference/wrong-order/opened-used reasons per
-- the locked scope). `batch_id` is populated on approval - the QC-pending
-- batch server/src/services/returnsService.js creates to receive this
-- item's physical stock back (null until then; stays null forever for a
-- rejected request, since nothing is ever received).
-- -------------------------------------------------------------
create table return_request_items (
  id uuid primary key default gen_random_uuid(),
  return_request_id uuid not null references return_requests(id) on delete cascade,
  order_item_id uuid not null references order_items(id),
  qty int not null check (qty > 0),
  reason text not null check (reason in ('damaged', 'leaked', 'defective', 'wrong_product', 'expired', 'tampered', 'missing_item')),
  batch_id uuid references batches(id),
  created_at timestamptz not null default now()
);
create index idx_return_request_items_request on return_request_items(return_request_id);
create index idx_return_request_items_order_item on return_request_items(order_item_id);

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — read-only for customers (mirrors "customers view
-- own orders"/"customers view own order items" exactly, including the
-- shape of the nested-table policy). All writes (create, review, refund)
-- go through the server's service-role key with explicit ownership/
-- eligibility checks in code, the same as every other Phase 6A/6B route -
-- there is no scenario where a customer's own anon-key client should
-- write these rows directly, since eligibility/window/amount validation
-- must be server-enforced.
-- -------------------------------------------------------------
alter table return_requests enable row level security;
alter table return_request_items enable row level security;

create policy "customers view own return requests" on return_requests
  for select using (auth.uid() = customer_id);
create policy "customers view own return request items" on return_request_items
  for select using (exists (
    select 1 from return_requests r where r.id = return_request_items.return_request_id and r.customer_id = auth.uid()
  ));

-- -------------------------------------------------------------
-- SETTINGS — codRefundEnabled feature flag, default OFF, using the
-- existing generic settings(key, value jsonb) mechanism (server/src/
-- routes/settings.js) unchanged - no new settings infrastructure.
-- -------------------------------------------------------------
insert into settings (key, value) values ('returns', '{"cod_refund_enabled": false}')
on conflict (key) do nothing;
