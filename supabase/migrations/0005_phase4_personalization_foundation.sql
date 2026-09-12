-- =============================================================
-- AyurVeda Store — Phase 4 migration: Personalization foundation
--
-- Run this once in your Supabase project's SQL Editor (same workflow as
-- every prior migration: Dashboard -> SQL Editor -> New query -> paste
-- this whole file -> Run).
--
-- Purely additive: creates new tables only. Does not drop, rename, or
-- modify any existing table, column, or row - including the pre-existing
-- `dosha_results` table (Phase 1), which is left exactly as-is. The new,
-- richer assessment (Dosha + Goals + Concerns, admin-editable questions)
-- functionally supersedes it going forward, but nothing is deleted -
-- `dosha_results` simply stops being written to by the new code path.
--
-- Deliberately reuses Phase 3's exact conventions throughout: `goal_id`/
-- `concern_id` reference the same shared `categories` table Phase 3
-- already uses (no new taxonomy tables), join tables follow the same
-- `unique(a,b)` + `on delete cascade` shape as product_concerns/benefits/
-- goals/ingredients, and status columns follow blog_posts'/faqs'
-- draft/published convention.
-- =============================================================

-- -------------------------------------------------------------
-- WELLNESS ASSESSMENT — admin-editable questions, each contributing to
-- exactly one of Dosha / Goal / Concern. An option's "vote" target is
-- whichever one of dosha/goal_id/concern_id is set - enforced by the
-- check constraint below rather than three separate tables, since a
-- question's options are otherwise structurally identical (label +
-- sort_order) regardless of dimension.
-- -------------------------------------------------------------
create table wellness_questions (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  dimension text not null check (dimension in ('dosha', 'goal', 'concern')),
  sort_order int not null default 0,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wellness_question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references wellness_questions(id) on delete cascade,
  label text not null,
  dosha text check (dosha in ('vata', 'pitta', 'kapha')),
  goal_id uuid references categories(id) on delete cascade,
  concern_id uuid references categories(id) on delete cascade,
  sort_order int not null default 0,
  constraint wellness_option_exactly_one_target check (
    (case when dosha is not null then 1 else 0 end) +
    (case when goal_id is not null then 1 else 0 end) +
    (case when concern_id is not null then 1 else 0 end) = 1
  )
);
create index idx_wellness_question_options_question on wellness_question_options(question_id);

-- -------------------------------------------------------------
-- WELLNESS PROFILE — one row per assessment SUBMISSION (full history,
-- never overwritten). `answers` keeps the raw {question_id, option_id}
-- pairs for audit/explainability; `result_dosha` is the deterministic
-- vote-count winner computed server-side at submission time.
--
-- The customer's CURRENT profile is deliberately NOT a separate mutable
-- table - it is derived consistently as "the most recent
-- wellness_assessments row for this customer" (see
-- server/src/services/wellnessService.js), avoiding a second place the
-- same fact could drift out of sync.
-- -------------------------------------------------------------
create table wellness_assessments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references auth.users(id) on delete cascade,
  answers jsonb not null,
  result_dosha text not null check (result_dosha in ('vata', 'pitta', 'kapha')),
  created_at timestamptz not null default now()
);
create index idx_wellness_assessments_customer on wellness_assessments(customer_id, created_at desc);

-- The customer's CURRENT goal/concern tags, derived from their most
-- recent submission's goal/concern-dimension answers - shaped exactly
-- like product_goals/product_concerns (Phase 3) so the recommendation
-- engine can intersect "what the customer wants" with "what the product
-- offers" using the same join-table pattern on both sides, not two
-- different matching mechanisms. Replaced wholesale on every new
-- submission (old rows deleted, new ones inserted) - same "replace the
-- full set" shape as products.js's PUT /:id/relationships.
create table customer_wellness_goals (
  customer_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references categories(id) on delete cascade,
  assessment_id uuid not null references wellness_assessments(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (customer_id, goal_id)
);
create table customer_wellness_concerns (
  customer_id uuid not null references auth.users(id) on delete cascade,
  concern_id uuid not null references categories(id) on delete cascade,
  assessment_id uuid not null references wellness_assessments(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (customer_id, concern_id)
);

-- -------------------------------------------------------------
-- DOSHA SUITABILITY — structured, admin-manageable (never hardcoded).
-- Product-level rather than ingredient-level: real product data today
-- has no ingredient tagging yet (Phase 3 audit), so requiring that chain
-- first would leave dosha-based recommendations empty until a full
-- ingredient graph exists. A product can be tagged with any number of
-- suitable doshas directly, the same way it already carries concern/
-- benefit/goal/ingredient tags.
-- -------------------------------------------------------------
create table product_doshas (
  product_id uuid not null references products(id) on delete cascade,
  dosha text not null check (dosha in ('vata', 'pitta', 'kapha')),
  created_at timestamptz not null default now(),
  unique (product_id, dosha)
);
create index idx_product_doshas_product on product_doshas(product_id);
create index idx_product_doshas_dosha on product_doshas(dosha);

-- -------------------------------------------------------------
-- PERSONALIZED ROUTINES — predefined, admin-authored templates only
-- (never dynamically generated). `dosha` null = suits everyone;
-- routine_goals lets a routine also be matched by goal overlap, the same
-- deterministic tag-intersection approach as product recommendations.
-- -------------------------------------------------------------
create table routine_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  description text,
  dosha text check (dosha in ('vata', 'pitta', 'kapha')),
  status text not null default 'draft' check (status in ('draft', 'published')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table routine_goals (
  routine_id uuid not null references routine_templates(id) on delete cascade,
  goal_id uuid not null references categories(id) on delete cascade,
  unique (routine_id, goal_id)
);

create table routine_steps (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references routine_templates(id) on delete cascade,
  step_order int not null default 0,
  time_of_day text check (time_of_day in ('morning', 'afternoon', 'evening', 'anytime')),
  title text not null,
  instructions text,
  product_id uuid references products(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_routine_steps_routine on routine_steps(routine_id);

-- -------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Content tables (questions/options, dosha tags, routines) follow the
-- exact same public-read pattern as Phase 3's categories/product_concerns/
-- blog_posts. Customer data tables (assessments, current goal/concern
-- tags) follow addresses'/orders' exact customer-scoped pattern - no
-- public policy, only the owning customer (auth.uid() = customer_id) or
-- the server's service-role key can ever read them. This is the primary
-- privacy guarantee for wellness data, mirrored (not replaced) by the
-- application-layer `customer_id = req.customer.id` filtering every new
-- route also applies, the same defense-in-depth relationship RLS already
-- has with every other customer-owned table in this schema.
-- -------------------------------------------------------------
alter table wellness_questions enable row level security;
alter table wellness_question_options enable row level security;
alter table wellness_assessments enable row level security;
alter table customer_wellness_goals enable row level security;
alter table customer_wellness_concerns enable row level security;
alter table product_doshas enable row level security;
alter table routine_templates enable row level security;
alter table routine_goals enable row level security;
alter table routine_steps enable row level security;

create policy "public read published wellness questions" on wellness_questions
  for select using (status = 'published');
create policy "public read options of published wellness questions" on wellness_question_options
  for select using (exists (
    select 1 from wellness_questions q where q.id = wellness_question_options.question_id and q.status = 'published'
  ));

create policy "customers view own wellness assessments" on wellness_assessments
  for select using (auth.uid() = customer_id);
create policy "customers view own wellness goals" on customer_wellness_goals
  for select using (auth.uid() = customer_id);
create policy "customers view own wellness concerns" on customer_wellness_concerns
  for select using (auth.uid() = customer_id);

create policy "public read product doshas" on product_doshas
  for select using (true);

create policy "public read published routines" on routine_templates
  for select using (status = 'published');
create policy "public read routine goals" on routine_goals
  for select using (true);
create policy "public read routine steps" on routine_steps
  for select using (true);
