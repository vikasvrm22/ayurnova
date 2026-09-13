-- =============================================================
-- AyurVeda Store — Phase 7 migration: Customer Communications &
-- Legal Readiness
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration). Purely additive: two new tables, no changes to
-- any existing table/column. Reuses the existing `integration_configs`
-- table (Phase 2) unchanged for email/SMS/WhatsApp provider credentials -
-- it was already designed generically ("Razorpay is its first consumer,
-- not a Razorpay-specific table" - see server/src/integrations/
-- integrationService.js), so a new channel is just a new (provider,
-- environment) row, no schema change needed for that part.
-- =============================================================

-- -------------------------------------------------------------
-- NOTIFICATION_LOG — one row per (event, channel) delivery attempt.
-- `unique (event, channel, dedupe_key)` is the actual idempotency guard
-- (same pattern as Phase 2's `webhook_events.unique(gateway, event_id)`):
-- a duplicate trigger for the same business event on the same channel
-- fails the insert with a unique violation, which the notification
-- dispatcher (server/src/notify/notificationService.js) treats as
-- "already attempted, no-op" rather than an error. `dedupe_key` is
-- whatever uniquely identifies the underlying business event for that
-- notification (an order id for order_placed/shipped/delivered/cancelled,
-- a return_request id for return_approved/rejected, a refund id for
-- refund_completed) - never a random value, so a genuine retry of the
-- exact same event can never double-send.
-- -------------------------------------------------------------
create table notification_log (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in (
    'order_placed', 'order_shipped', 'order_delivered', 'order_cancelled',
    'return_approved', 'return_rejected', 'refund_completed'
  )),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  dedupe_key text not null,
  order_id uuid references orders(id) on delete set null,
  return_request_id uuid references return_requests(id) on delete set null,
  customer_id uuid references auth.users(id) on delete set null,
  -- The recipient address/number actually used for this attempt - staff
  -- already see this same contact info on the order/customer record
  -- elsewhere in the admin (orders-list, order-detail), so surfacing it
  -- again here in read-only history is not a new exposure. Never a
  -- gateway id, webhook payload, or other operational internal.
  recipient text,
  status text not null default 'skipped' check (status in ('sent', 'failed', 'skipped')),
  skip_reason text,
  -- A short, safe, human-readable failure reason only - never a raw
  -- provider response body/stack trace (see notificationService.js's own
  -- truncation before writing here).
  error_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (event, channel, dedupe_key)
);
create index idx_notification_log_order on notification_log(order_id);
create index idx_notification_log_customer on notification_log(customer_id, created_at desc);
create index idx_notification_log_created on notification_log(created_at desc);
create index idx_notification_log_event_channel_status on notification_log(event, channel, status);

-- -------------------------------------------------------------
-- LEGAL_PAGES — exactly four admin-editable CMS pages (the fixed slug
-- check constraint below is deliberate, not an oversight: this is not a
-- general-purpose page builder, just these four legally-relevant pages).
-- Seeded below as unpublished drafts with clearly-marked placeholder
-- content - nobody should ever see AI/assistant-authored legal text
-- presented as the business's real policy, so every seed row starts in
-- 'draft' and stays that way until a human with real content publishes it.
-- -------------------------------------------------------------
create table legal_pages (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug in (
    'terms-and-conditions', 'privacy-policy', 'return-refund-policy', 'shipping-policy'
  )),
  title text not null,
  -- Sanitized (allowlisted-tags-only) HTML from the admin's rich-text
  -- editor - see server/src/routes/legalAdmin.js, which re-sanitizes on
  -- every save server-side (never trusts the browser's DOM state alone).
  content_html text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text,
  created_at timestamptz not null default now()
);

insert into legal_pages (slug, title, content_html, status) values
  ('terms-and-conditions', 'Terms & Conditions',
   '<p><strong>DRAFT — BUSINESS CONTENT REQUIRED.</strong> This placeholder was created automatically by the Phase 7 migration. Replace it with your business-approved Terms &amp; Conditions, then Publish from Admin → Legal Pages.</p>', 'draft'),
  ('privacy-policy', 'Privacy Policy',
   '<p><strong>DRAFT — BUSINESS CONTENT REQUIRED.</strong> This placeholder was created automatically by the Phase 7 migration. Replace it with your business-approved Privacy Policy, then Publish from Admin → Legal Pages.</p>', 'draft'),
  ('return-refund-policy', 'Return & Refund Policy',
   '<p><strong>DRAFT — BUSINESS CONTENT REQUIRED.</strong> This placeholder was created automatically by the Phase 7 migration. Replace it with your business-approved Return &amp; Refund Policy, then Publish from Admin → Legal Pages.</p>', 'draft'),
  ('shipping-policy', 'Shipping Policy',
   '<p><strong>DRAFT — BUSINESS CONTENT REQUIRED.</strong> This placeholder was created automatically by the Phase 7 migration. Replace it with your business-approved Shipping Policy, then Publish from Admin → Legal Pages.</p>', 'draft')
on conflict (slug) do nothing;

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY — same convention as every Phase 2+ operational
-- table (payments/webhook_events/return_requests/etc): no public
-- policies. Only the service-role key (used exclusively by the Express
-- server) can reach these tables. Customers never query notification_log
-- directly (there is no customer-facing notification API - staff-only
-- history, RBAC-gated in application code, same as every other admin
-- permission in server/src/config.js ROLE_PERMISSIONS). Public legal
-- pages are served by the server filtering on status='published' itself
-- (same pattern as blog_posts/faqs), not via a public RLS policy.
-- -------------------------------------------------------------
alter table notification_log enable row level security;
alter table legal_pages enable row level security;
