-- =============================================================
-- Phase 9B (P1-5) — ERROR_LOG: a minimal persistent record of
-- unhandled exceptions and other background failures that previously
-- only reached console.error (server-side stdout only, invisible to
-- any admin after the fact). Deliberately additive/minimal - not a
-- general-purpose logging framework, just the three spots the Phase 9
-- audit named as genuinely invisible today:
--   1. server/src/middleware/errorHandler.js — every unhandled 500.
--   2. server/src/analytics/tracker.js — analytics-flush failures.
--   3. server/src/notify/notificationService.js — a failure BEFORE a
--      per-channel send attempt is even recorded to notification_log
--      (e.g. inside resolveRecipient).
-- Payment/refund/webhook/notification-send failures already have their
-- own durable, specific records (payment_attempts, webhook_events,
-- notification_log) and are NOT duplicated here.
-- =============================================================

create table error_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,        -- e.g. 'http_error_handler', 'analytics_flush', 'notification_service'
  message text not null,
  stack text,
  context jsonb,                -- small, non-secret context only (path/method/event/ids) - never a raw request body or credentials
  created_at timestamptz not null default now()
);

create index error_log_created_at_idx on error_log (created_at desc);
create index error_log_source_idx on error_log (source);

-- Same zero-public-policy pattern as activity_log/settings/staff_users -
-- the Express server writes/reads exclusively via the service-role key
-- (bypasses RLS); this is a second line of defense for the anon/browser
-- key, which should never be able to read or write this table.
alter table error_log enable row level security;
