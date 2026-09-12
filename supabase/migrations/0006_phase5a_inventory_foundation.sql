-- =============================================================
-- AyurVeda Store — Phase 5A migration: Inventory foundation
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration: Dashboard -> SQL Editor -> New query -> paste
-- this whole file -> Run).
--
-- Purely additive: creates new tables + two new functions only. Does not
-- drop, rename, or modify any existing table or column - `product_variants`
-- keeps its existing `stock` column exactly as-is (same name, same type),
-- so every pre-existing read site (catalogService.js, catalogPublic.js,
-- pages.js, dashboard.js, checkout in public.js/paymentService.js) keeps
-- working completely unchanged.
--
-- Locked decision for Phase 5A: batch quantity is the inventory source of
-- truth; `product_variants.stock` becomes a MAINTAINED AGGREGATE of
-- sellable batch quantity, no longer a manually-typed number (see the
-- matching server/src/routes/products.js change in this same commit, which
-- stops accepting a client-supplied `stock` value on variant create/update).
--
-- Deliberately NOT done in this migration (explicitly out of scope for the
-- "foundation" sub-phase - see Phase 5A task):
--   - FEFO allocation at checkout/sale time. Checkout (public.js,
--     paymentService.js) is UNCHANGED - it still decrements
--     product_variants.stock directly via the existing decrement_variant_stock
--     RPC. That RPC is left completely untouched.
--   - Cancellation-restock workflow.
--   - Any admin UI (HTML) for batches - this migration only lays the data
--     foundation + the server-side functions/routes that operate on it.
--
-- Because batch-driven stock changes below are applied as a DELTA on top
-- of the current product_variants.stock value (never a full recompute-
-- from-scratch), they never clobber whatever checkout has already
-- decremented. This is a deliberate, known trade-off of shipping the
-- foundation before FEFO exists: until sale-time FEFO allocation lands in
-- a later sub-phase, a sale decrements the aggregate `stock` column but
-- does not decrement any specific batch's `quantity` - so batch quantities
-- and the aggregate can drift apart from each other after a sale. This is
-- expected and intentional for this sub-phase, not a defect.
-- =============================================================

-- -------------------------------------------------------------
-- BATCHES — one row per received lot of a sellable product_variant.
-- `quantity` is this batch's own current remaining quantity (not an
-- original/received quantity - it is decremented/incremented in place by
-- inventory_ledger-producing operations, the same "current remaining
-- value" shape product_variants.stock itself already had pre-Phase-5).
--
-- Sellability (see is_batch_sellable() below) requires ALL of:
--   batch_status = 'active' AND quality_status = 'passed' AND
--   (expiry_date IS NULL OR expiry_date >= current_date)
-- i.e. quarantined/expired/recalled batch_status, or pending/failed
-- quality_status, or a past expiry_date, all exclude a batch from
-- contributing to the variant's sellable stock aggregate - per the locked
-- decision that non-sellable batches (expired/quarantined/failed-QC/
-- recalled) are excluded.
--
-- known limitation (documented, not fixed here - no scheduled-job
-- infrastructure exists anywhere yet in this project): a batch that ages
-- past its own expiry_date with no admin write to it will NOT automatically
-- roll off product_variants.stock, since nothing triggers a recompute
-- without a row change. A scheduled sweep (or lazy recompute at read time)
-- is future work, not part of this foundation.
-- -------------------------------------------------------------
create table batches (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references product_variants(id) on delete cascade,
  batch_number text not null,
  quantity int not null default 0 check (quantity >= 0),
  mfg_date date,
  expiry_date date,
  quality_status text not null default 'pending' check (quality_status in ('pending', 'passed', 'failed')),
  batch_status text not null default 'active' check (batch_status in ('active', 'quarantined', 'expired', 'recalled')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (variant_id, batch_number)
);
create index idx_batches_variant on batches(variant_id);
create index idx_batches_expiry on batches(expiry_date);
create index idx_batches_status on batches(batch_status, quality_status);

-- -------------------------------------------------------------
-- INVENTORY LEDGER — append-only audit trail of every quantity change to
-- a batch (received stock, corrections, wastage, status-change-driven
-- sellable/unsellable flips). Never updated or deleted - a correction is
-- always a NEW ledger row, never an edit of a past one, so the history
-- stays a true audit trail. `resulting_quantity` snapshots the batch's
-- quantity immediately after this entry, so history can be read without
-- having to replay every prior entry to know what the batch held at any
-- point in time.
-- -------------------------------------------------------------
create table inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references batches(id) on delete cascade,
  variant_id uuid not null references product_variants(id) on delete cascade,
  change_qty int not null,
  reason text not null,
  actor text not null,
  resulting_quantity int not null,
  created_at timestamptz not null default now()
);
create index idx_inventory_ledger_batch on inventory_ledger(batch_id, created_at desc);
create index idx_inventory_ledger_variant on inventory_ledger(variant_id, created_at desc);

-- -------------------------------------------------------------
-- SERVER-AUTHORITATIVE ATOMIC OPERATIONS
--
-- All batch quantity/status changes MUST go through adjust_batch_quantity()
-- or set_batch_status() below, never a plain UPDATE from application code -
-- these are the only things that keep a ledger row, a batch row, and
-- product_variants.stock consistent with each other inside a single
-- transaction (one function call = one atomic unit, the same principle
-- the pre-existing decrement_variant_stock() RPC already established for
-- checkout).
-- -------------------------------------------------------------
create or replace function is_batch_sellable(p_quality_status text, p_batch_status text, p_expiry_date date)
returns boolean as $$
  select p_batch_status = 'active'
     and p_quality_status = 'passed'
     and (p_expiry_date is null or p_expiry_date >= current_date);
$$ language sql immutable;

-- Applies `p_delta` (positive = received/correction-up, negative =
-- wastage/correction-down) to a batch's quantity, logs a ledger row, and -
-- only if the batch is CURRENTLY sellable - applies the same delta to the
-- owning variant's product_variants.stock aggregate. Raises if the
-- resulting batch quantity would go negative (a batch can never hold
-- negative stock).
create or replace function adjust_batch_quantity(p_batch_id uuid, p_delta int, p_reason text, p_actor text)
returns batches as $$
declare
  v_batch batches;
  v_new_qty int;
  v_sellable boolean;
begin
  select * into v_batch from batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'Batch % not found', p_batch_id;
  end if;

  v_new_qty := v_batch.quantity + p_delta;
  if v_new_qty < 0 then
    raise exception 'Resulting quantity (%) cannot be negative for batch %', v_new_qty, p_batch_id;
  end if;

  v_sellable := is_batch_sellable(v_batch.quality_status, v_batch.batch_status, v_batch.expiry_date);

  update batches set quantity = v_new_qty, updated_at = now()
    where id = p_batch_id
    returning * into v_batch;

  insert into inventory_ledger (batch_id, variant_id, change_qty, reason, actor, resulting_quantity)
  values (p_batch_id, v_batch.variant_id, p_delta, p_reason, p_actor, v_new_qty);

  if v_sellable and p_delta <> 0 then
    update product_variants set stock = greatest(0, stock + p_delta) where id = v_batch.variant_id;
  end if;

  return v_batch;
end;
$$ language plpgsql;

-- Changes a batch's batch_status and/or quality_status. If this flips the
-- batch's sellability (per is_batch_sellable), the batch's full current
-- quantity moves into or out of the variant's stock aggregate, and a
-- ledger row records that movement (change_qty = +quantity when becoming
-- sellable, -quantity when becoming unsellable) - so the ledger always
-- fully explains every change to the aggregate, not just quantity receipts.
create or replace function set_batch_status(p_batch_id uuid, p_batch_status text, p_quality_status text, p_actor text, p_reason text)
returns batches as $$
declare
  v_batch batches;
  v_was_sellable boolean;
  v_is_sellable boolean;
  v_movement int;
begin
  select * into v_batch from batches where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'Batch % not found', p_batch_id;
  end if;

  v_was_sellable := is_batch_sellable(v_batch.quality_status, v_batch.batch_status, v_batch.expiry_date);
  v_is_sellable := is_batch_sellable(
    coalesce(p_quality_status, v_batch.quality_status),
    coalesce(p_batch_status, v_batch.batch_status),
    v_batch.expiry_date
  );

  update batches set
    batch_status = coalesce(p_batch_status, batch_status),
    quality_status = coalesce(p_quality_status, quality_status),
    updated_at = now()
    where id = p_batch_id
    returning * into v_batch;

  if v_was_sellable <> v_is_sellable and v_batch.quantity > 0 then
    v_movement := case when v_is_sellable then v_batch.quantity else -v_batch.quantity end;

    insert into inventory_ledger (batch_id, variant_id, change_qty, reason, actor, resulting_quantity)
    values (p_batch_id, v_batch.variant_id, v_movement, coalesce(p_reason, 'status_change'), p_actor, v_batch.quantity);

    update product_variants set stock = greatest(0, stock + v_movement) where id = v_batch.variant_id;
  end if;

  return v_batch;
end;
$$ language plpgsql;

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — batches and inventory_ledger are staff-only data
-- (cost/supplier/QC-adjacent details, and a full audit trail, are never
-- meant for customer or public exposure). Same zero-public-policy pattern
-- already used for settings/coupons/staff_users/page_views/activity_log
-- (see supabase/schema.sql's closing comment) - RLS enabled, no policies
-- at all, so only the server's service-role key can reach these tables.
-- -------------------------------------------------------------
alter table batches enable row level security;
alter table inventory_ledger enable row level security;
