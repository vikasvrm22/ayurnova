-- =============================================================
-- AyurVeda Store — Phase 8B migration: Shipping & Logistics
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Additive only: four new tables, one widened
-- check constraint on `orders.status`, one widened check constraint on
-- `notification_log.event`, and two seeded `integration_configs` rows for
-- the credential-less "manual" courier provider. Does not drop, rename, or
-- modify any existing column.
--
-- Locked decisions this migration implements:
--   - Shipment status is authoritative; `orders.status` gets a new 'rto'
--     value so an order physically coming back to the warehouse is never
--     misrepresented as still 'shipped' (server/src/services/
--     shipmentService.js keeps the two in sync on every transition).
--   - RTO/returned goods NEVER become sellable automatically - physical
--     receipt creates a QC-pending batch (quality_status='pending', exactly
--     Phase 6B's receiveReturnedItem() pattern) via the EXISTING Phase 5A
--     adjust_batch_quantity()/set_batch_status() functions, unchanged. Only
--     a later admin QC pass (existing Inventory page, existing
--     PUT /api/admin/inventory/batches/:id/status route) can ever move that
--     quantity into product_variants.stock - no new code path can.
--   - Cancellation-restock (restock_order(), Phase 5B) is never called for
--     a physical RTO - shipment_rto_receipts/shipment_rto_receipt_items
--     below are a completely separate, additive intake record.
-- =============================================================

-- -------------------------------------------------------------
-- SHIPMENTS — at most one non-cancelled shipment per order (the partial
-- unique index below enforces this at the DB level, the same final
-- backstop payment_attempts.gateway_order_id already uses for its own
-- one-per-attempt uniqueness). `provider`/`environment` reuse the exact
-- (provider, environment) shape integration_configs already established
-- (Phase 2) - a real courier is just another provider row, no schema
-- change needed, same story as Phase 7's email/SMS/WhatsApp channels.
-- `provider_meta` is safe, non-secret metadata only (never a raw webhook
-- payload with credentials) - see shipmentService.js's own boundary
-- comment for what may ever be written there.
-- -------------------------------------------------------------
create table shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  provider text not null,
  environment text not null default 'test' check (environment in ('test', 'production')),
  status text not null default 'pending' check (status in (
    'pending', 'label_generated', 'pickup_scheduled', 'picked_up', 'in_transit',
    'out_for_delivery', 'delivered', 'failed_delivery',
    'rto_initiated', 'rto_in_transit', 'rto_delivered', 'cancelled'
  )),
  provider_shipment_id text,
  awb_number text,
  courier_name text,
  label_url text,
  tracking_url text,
  eta date,
  pickup_scheduled_at timestamptz,
  out_for_delivery_at timestamptz,
  delivered_at timestamptz,
  failed_delivery_at timestamptz,
  rto_initiated_at timestamptz,
  rto_delivered_at timestamptz,
  cancelled_at timestamptz,
  last_status_reason text,
  provider_meta jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_shipments_order on shipments(order_id);
create index idx_shipments_status on shipments(status);
-- Only one row per (provider, provider_shipment_id) - the idempotency
-- anchor a courier webhook resolves a local shipment through.
create unique index idx_shipments_provider_shipment_id on shipments(provider, provider_shipment_id) where provider_shipment_id is not null;
-- Only one ACTIVE (non-cancelled) shipment per order - a cancelled
-- shipment frees the order up for a fresh one (e.g. re-ship after a
-- pre-dispatch cancellation), but never two live shipments at once.
create unique index idx_shipments_one_active_per_order on shipments(order_id) where status <> 'cancelled';

-- -------------------------------------------------------------
-- SHIPMENT_EVENTS — append-only audit trail of every shipment status
-- transition, exactly the same "never updated/deleted, one row per
-- change" discipline as Phase 5A's inventory_ledger. `source` records
-- whether a human (admin), a courier (webhook), or the system made the
-- change - `raw_payload` is only ever populated for a webhook-sourced
-- event, and only with the already-idempotency-recorded webhook_events
-- payload (never anything containing a decrypted secret).
-- -------------------------------------------------------------
create table shipment_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  previous_status text,
  new_status text not null,
  source text not null check (source in ('admin', 'webhook', 'system')),
  actor text,
  note text,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);
create index idx_shipment_events_shipment on shipment_events(shipment_id, created_at desc);

-- -------------------------------------------------------------
-- SHIPMENT_RTO_RECEIPTS / SHIPMENT_RTO_RECEIPT_ITEMS — the physical
-- "package came back to the warehouse" event, one row per shipment
-- (unique(shipment_id) below - an RTO is received exactly once).
-- Deliberately has NO status/disposition column of its own: QC
-- pending/passed/failed is the linked batch's own quality_status (Phase
-- 5A), read live from the existing Inventory page - keeping a second,
-- parallel "RTO status" column here would create exactly the kind of
-- two-sources-of-truth drift this schema otherwise avoids everywhere else
-- (batches.quality_status is already the one authoritative QC state).
-- -------------------------------------------------------------
create table shipment_rto_receipts (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  received_by text not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (shipment_id)
);

create table shipment_rto_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references shipment_rto_receipts(id) on delete cascade,
  order_item_id uuid not null references order_items(id),
  qty int not null check (qty > 0),
  batch_id uuid references batches(id),
  created_at timestamptz not null default now()
);
create index idx_rto_receipt_items_receipt on shipment_rto_receipt_items(receipt_id);

-- -------------------------------------------------------------
-- ORDERS: widen status to add 'rto' - additive only, every existing row
-- and every existing caller checking for the original 5 values keeps
-- working unchanged (same widening pattern as Phase 2's payment_status).
-- Set exclusively by shipmentService.js when a shipment enters an RTO
-- state - never directly settable via PUT /api/admin/orders/:id/status
-- any more (see that route's own updated ORDER_STATUSES/ADMIN_SETTABLE_
-- STATUSES split).
-- -------------------------------------------------------------
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled', 'rto'));

-- -------------------------------------------------------------
-- NOTIFICATION_LOG: widen event to add the two Phase 8B events - additive
-- only, same widening pattern as every prior phase's own constraint
-- change. Content templates for both live in notificationService.js.
-- -------------------------------------------------------------
alter table notification_log drop constraint if exists notification_log_event_check;
alter table notification_log add constraint notification_log_event_check
  check (event in (
    'order_placed', 'order_shipped', 'order_delivered', 'order_cancelled',
    'return_approved', 'return_rejected', 'refund_completed',
    'order_out_for_delivery', 'order_delivery_failed'
  ));

-- -------------------------------------------------------------
-- SEED: the "manual" courier provider needs no credentials at all (staff
-- enter AWB/courier/status by hand, exactly like every order before this
-- phase), so it is seeded pre-enabled in BOTH environments - Phase 8B is
-- fully usable without any admin ever visiting Integrations, satisfying
-- the locked "do not require real courier credentials for completion"
-- rule. A real courier (added later, same generic integration_configs
-- pattern as Razorpay/email/SMS/WhatsApp) starts disabled as normal.
-- -------------------------------------------------------------
insert into integration_configs (provider, environment, enabled, extra) values
  ('manual', 'test', true, '{}'::jsonb),
  ('manual', 'production', true, '{}'::jsonb)
on conflict (provider, environment) do nothing;

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — shipments gets a customer read-only policy
-- mirroring "customers view own orders" exactly (defense in depth only -
-- the actual customer-facing API in orderDetailPublic.js always reads via
-- the server's service-role key, never a customer's own anon-key
-- session). shipment_events/shipment_rto_receipts/shipment_rto_receipt_items
-- are staff-only operational detail, same zero-public-policy convention as
-- batches/inventory_ledger/order_item_batch_allocations.
-- -------------------------------------------------------------
alter table shipments enable row level security;
alter table shipment_events enable row level security;
alter table shipment_rto_receipts enable row level security;
alter table shipment_rto_receipt_items enable row level security;

create policy "customers view own shipments" on shipments
  for select using (exists (select 1 from orders o where o.id = shipments.order_id and o.customer_id = auth.uid()));
