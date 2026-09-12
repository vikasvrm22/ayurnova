-- =============================================================
-- AyurVeda Store — Phase 5B migration: FEFO batch allocation
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Purely additive: one new table + four new
-- functions. Does not drop, rename, or modify any existing table/column/
-- function - Phase 5A's batches/inventory_ledger/is_batch_sellable()/
-- adjust_batch_quantity()/set_batch_status() are reused UNCHANGED as the
-- building blocks for everything below, per the "avoid parallel stock
-- logic" instruction.
--
-- Locked decisions this migration implements:
--   - FEFO: earliest valid expiry first (NULLS LAST, i.e. a batch with no
--     expiry date is treated as expiring "latest", so it's consumed only
--     after every dated batch with an actual expiry is exhausted).
--   - Allocation across multiple batches for one order line is normal
--     (a line can be partially filled from batch A, then batch B, ...).
--   - Insufficient eligible (sellable) batch stock fails the WHOLE order's
--     allocation atomically - no partial allocation ever persists.
--   - Cancellation restocks exactly the batch(es) originally allocated to
--     that order, each restock producing its own auditable ledger entry
--     (via the existing adjust_batch_quantity()).
-- =============================================================

-- -------------------------------------------------------------
-- ORDER_ITEM_BATCH_ALLOCATIONS — the historical, immutable record of which
-- batch(es) fulfilled each order_item and how much came from each. This is
-- the "cannot change when batches later change" reference the task asks
-- for: `batch_number_snapshot` is captured at allocation time so the
-- record stays readable/meaningful even if the batch's own batch_number
-- were ever edited (it isn't, today - no edit route exists - but this
-- keeps the historical row self-contained regardless), and `batch_id`
-- has NO `on delete cascade`/`on delete set null` - a batch that has ever
-- fulfilled a real order can never be deleted out from under its own
-- audit trail (there is no batch-delete route anyway, but this is the
-- correct constraint regardless of today's API surface).
-- -------------------------------------------------------------
create table order_item_batch_allocations (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  batch_id uuid not null references batches(id),
  batch_number_snapshot text not null,
  variant_id uuid not null references product_variants(id),
  qty int not null check (qty > 0),
  created_at timestamptz not null default now()
);
create index idx_oiba_order_item on order_item_batch_allocations(order_item_id);
create index idx_oiba_batch on order_item_batch_allocations(batch_id);

-- -------------------------------------------------------------
-- FEFO ALLOCATION — allocate_fefo_stock() is the per-order-item primitive;
-- allocate_fefo_stock_for_order() loops it over every item of one order.
-- Calling the per-ORDER function once gives genuine atomicity across every
-- line in the cart: all the work happens inside ONE plpgsql function call,
-- i.e. one Postgres transaction, so a RAISE EXCEPTION on any single line
-- (insufficient eligible stock) rolls back every earlier line's batch
-- decrement/ledger entry/allocation row in the same call too - no partial
-- allocation can ever be observed, even across multiple cart lines.
--
-- Each batch row is locked (`for update`) as the FEFO cursor reaches it,
-- and adjust_batch_quantity() (Phase 5A) does the actual quantity
-- decrement + ledger row + variant-stock delta for whichever batch(es)
-- get consumed - this function only decides WHICH batch(es) and HOW MUCH,
-- never touches batches.quantity or product_variants.stock directly.
-- -------------------------------------------------------------
create or replace function allocate_fefo_stock(p_variant_id uuid, p_qty int, p_order_item_id uuid, p_actor text, p_reason text)
returns void as $$
declare
  v_batch record;
  v_remaining int := p_qty;
  v_take int;
begin
  if p_qty <= 0 then
    raise exception 'Quantity to allocate must be positive';
  end if;

  for v_batch in
    select * from batches
    where variant_id = p_variant_id
      and batch_status = 'active'
      and quality_status = 'passed'
      and (expiry_date is null or expiry_date >= current_date)
      and quantity > 0
    order by expiry_date asc nulls last, created_at asc
    for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_batch.quantity, v_remaining);

    perform adjust_batch_quantity(v_batch.id, -v_take, p_reason, p_actor);

    insert into order_item_batch_allocations (order_item_id, batch_id, batch_number_snapshot, variant_id, qty)
    values (p_order_item_id, v_batch.id, v_batch.batch_number, p_variant_id, v_take);

    v_remaining := v_remaining - v_take;
  end loop;

  if v_remaining > 0 then
    raise exception 'Insufficient sellable batch stock for variant % (needed %, short %)', p_variant_id, p_qty, v_remaining;
  end if;
end;
$$ language plpgsql;

create or replace function allocate_fefo_stock_for_order(p_order_id uuid, p_actor text, p_reason text)
returns void as $$
declare
  v_item record;
begin
  for v_item in
    select id, variant_id, qty from order_items where order_id = p_order_id and variant_id is not null
  loop
    perform allocate_fefo_stock(v_item.variant_id, v_item.qty, v_item.id, p_actor, p_reason);
  end loop;
end;
$$ language plpgsql;

-- -------------------------------------------------------------
-- CANCELLATION RESTOCK — the exact inverse of allocation: restock_order()
-- loops every item of an order, restock_order_item() loops every batch
-- that was actually allocated to that one item (from
-- order_item_batch_allocations - never re-derived via FEFO, always the
-- batch(es) that were really taken) and gives each one back via
-- adjust_batch_quantity() with a positive delta, which - exactly like
-- allocation - only touches product_variants.stock if that batch is
-- CURRENTLY sellable. A batch recalled/expired after the original sale
-- does not silently become sellable again just because an old order
-- against it was cancelled - the existing Phase 5A sellability gate in
-- adjust_batch_quantity() already guarantees this for free.
-- -------------------------------------------------------------
create or replace function restock_order_item(p_order_item_id uuid, p_actor text, p_reason text)
returns void as $$
declare
  v_alloc record;
begin
  for v_alloc in
    select * from order_item_batch_allocations where order_item_id = p_order_item_id
  loop
    perform adjust_batch_quantity(v_alloc.batch_id, v_alloc.qty, p_reason, p_actor);
  end loop;
end;
$$ language plpgsql;

create or replace function restock_order(p_order_id uuid, p_actor text, p_reason text)
returns void as $$
declare
  v_item record;
begin
  for v_item in select id from order_items where order_id = p_order_id loop
    perform restock_order_item(v_item.id, p_actor, p_reason);
  end loop;
end;
$$ language plpgsql;

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — staff-only, same zero-public-policy pattern as
-- batches/inventory_ledger (Phase 5A) and settings/coupons/staff_users.
-- -------------------------------------------------------------
alter table order_item_batch_allocations enable row level security;
