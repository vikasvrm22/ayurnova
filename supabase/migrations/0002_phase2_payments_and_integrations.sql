-- =============================================================
-- AyurVeda Store — Phase 2 migration: Payments + Integration Management
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- the original supabase/schema.sql: Dashboard -> SQL Editor -> New query
-- -> paste this whole file -> Run).
--
-- Purely additive: creates new tables and widens one existing check
-- constraint. Does not drop, rename, or modify any existing column or
-- row. Safe to run on the live database - no existing data is touched.
-- =============================================================

-- -------------------------------------------------------------
-- INTEGRATION MANAGEMENT (generic foundation - Razorpay is its first
-- consumer, not a Razorpay-specific table, so a future integration
-- doesn't need its own parallel credential-management system)
-- -------------------------------------------------------------
create table integration_configs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                     -- e.g. 'razorpay'
  environment text not null check (environment in ('test','production')),
  enabled boolean not null default false,
  key_id text,                                 -- non-secret (e.g. Razorpay key_id - safe to expose to Checkout.js)
  key_secret_encrypted text,                   -- AES-256-GCM ciphertext - never stored in plaintext
  webhook_secret_encrypted text,                -- AES-256-GCM ciphertext
  extra jsonb not null default '{}'::jsonb,    -- room for provider-specific non-secret config
  last_tested_at timestamptz,
  last_test_status text check (last_test_status in ('success', 'failed')),
  last_test_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (provider, environment)
);

-- -------------------------------------------------------------
-- PAYMENTS — one row per order (the logical "payment for this order").
-- Attempts/history live in payment_attempts below.
-- -------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id) on delete cascade,
  gateway text not null default 'razorpay',
  environment text not null check (environment in ('test', 'production')),
  amount numeric(10, 2) not null check (amount >= 0),
  currency text not null default 'INR',
  status text not null default 'INITIATED' check (status in
    ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  refunded_amount numeric(10, 2) not null default 0 check (refunded_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_payments_order on payments(order_id);
create index idx_payments_status on payments(status);

-- -------------------------------------------------------------
-- PAYMENT ATTEMPTS — many per payment. Example: Order #10025,
-- Attempt 1 -> UPI -> FAILED, Attempt 2 -> UPI -> SUCCESS. Each attempt
-- corresponds to one Razorpay order (Razorpay requires a fresh order per
-- retry), so gateway_order_id is unique per attempt, not shared.
-- -------------------------------------------------------------
create table payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  attempt_number int not null,
  gateway_order_id text,              -- Razorpay order id, created at attempt start
  gateway_payment_id text,            -- Razorpay payment id, set once a payment method is used
  method text,                        -- upi / card / netbanking / wallet (from Razorpay's payload)
  status text not null default 'INITIATED' check (status in
    ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED')),
  failure_reason text,
  raw_event jsonb,                    -- verify/webhook payload, with sensitive fields stripped
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_id, attempt_number)
);
create index idx_payment_attempts_payment on payment_attempts(payment_id);
create unique index idx_payment_attempts_gateway_order on payment_attempts(gateway_order_id) where gateway_order_id is not null;
create index idx_payment_attempts_gateway_payment on payment_attempts(gateway_payment_id) where gateway_payment_id is not null;

-- -------------------------------------------------------------
-- REFUNDS
-- -------------------------------------------------------------
create table refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id) on delete cascade,
  attempt_id uuid references payment_attempts(id) on delete set null,
  gateway_refund_id text,
  amount numeric(10, 2) not null check (amount > 0),
  reason text,
  status text not null default 'INITIATED' check (status in ('INITIATED', 'PROCESSED', 'FAILED')),
  created_by text,                    -- staff email (audit trail)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_refunds_payment on refunds(payment_id);

-- -------------------------------------------------------------
-- WEBHOOK EVENTS — idempotency guard + audit trail. The unique
-- constraint on (gateway, event_id) is what makes webhook processing
-- idempotent: a duplicate delivery of the same event fails the insert
-- (handled in application code as "already processed, no-op").
-- -------------------------------------------------------------
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  gateway text not null default 'razorpay',
  event_id text not null,             -- Razorpay's event id
  event_type text not null,
  payload jsonb not null,
  signature_valid boolean not null,
  processing_status text not null default 'RECEIVED' check (processing_status in
    ('RECEIVED', 'PROCESSED', 'IGNORED', 'ERROR')),
  processing_note text,
  created_at timestamptz not null default now(),
  unique (gateway, event_id)
);
create index idx_webhook_events_created on webhook_events(created_at);

-- -------------------------------------------------------------
-- ORDERS: widen payment_status to support the fuller payment lifecycle.
-- Additive only - the existing 'unpaid' / 'paid' / 'refunded' values
-- already in use (and every existing row using them) remain valid as-is;
-- this only adds 'partially_refunded' and 'failed' to the allowed set.
-- -------------------------------------------------------------
alter table orders drop constraint if exists orders_payment_status_check;
alter table orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'paid', 'refunded', 'partially_refunded', 'failed'));

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — same convention as staff_users/settings/coupons:
-- no public policies. Only the service-role key (used exclusively by the
-- Express server) can reach these tables; customers see their own
-- payment status through the existing orders API, never by querying
-- these tables directly. RBAC for the new admin Integrations/Payments
-- screens is enforced in application code (server/src/config.js
-- ROLE_PERMISSIONS), matching every other permission in this schema.
-- -------------------------------------------------------------
alter table integration_configs enable row level security;
alter table payments enable row level security;
alter table payment_attempts enable row level security;
alter table refunds enable row level security;
alter table webhook_events enable row level security;
