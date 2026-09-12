-- =============================================================
-- AyurVeda Store — Phase 3 defect fix: FAQ status workflow
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration: Dashboard -> SQL Editor -> New query -> paste
-- this whole file -> Run).
--
-- Fixes a gap the independent Phase 3 audit found: docs/AYURVEDICSTORE-
-- PHASE-3-DECISIONS.md's locked decision #3 named a `faqs.status` column,
-- but 0003_phase3a_discovery_foundation.sql's `faqs` table shipped without
-- one - every FAQ was instantly public on save, unlike every other content
-- type in this app (products, blog_posts both have a draft/published
-- workflow). Purely additive: adds one column with a safe default and
-- narrows the existing "public read faqs" RLS policy to match - no
-- existing table, row, or other column is touched.
-- =============================================================

-- Same two-state convention as `blog_posts.status` (schema.sql) - FAQs are
-- simple admin-authored content like blog posts, not inventory-like
-- products that also need an 'archived' state.
alter table faqs add column if not exists status text not null default 'draft' check (status in ('draft', 'published'));

-- RLS: narrow from "public read faqs" using (true) (0003's default, before
-- there was a status to gate on) to match blog_posts' own policy shape -
-- a draft FAQ must not be readable via the anon key any more than a draft
-- blog post already isn't.
alter policy "public read faqs" on faqs using (status = 'published');
