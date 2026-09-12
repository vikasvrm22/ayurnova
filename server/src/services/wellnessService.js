/**
 * Phase 4 Personalization business logic - Wellness Assessment scoring,
 * Wellness Profile derivation, and Routine matching. Deterministic only
 * (no AI/ML/LLM anywhere in this file): dosha scoring is plain vote-
 * counting (server-side port of the pre-existing client-only logic in
 * public-site/dosha-test.html - the Phase 4 audit's own recommendation),
 * goal/concern derivation is a direct read of which options a customer
 * picked, and routine matching is explicit tag/dosha equality checks.
 *
 * Product recommendations themselves live in catalogService.js
 * (getRecommendedProducts) - this file derives the profile signals
 * (dosha/goalIds/concernIds) and hands them off, rather than duplicating
 * any product-matching logic here.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { DOSHAS, getRecommendedProducts as catalogGetRecommendedProducts } from "./catalogService.js";

/** Published questions + their published options, with goal/concern
 * options resolved to their category's name/slug - everything the
 * assessment UI needs to render, nothing it needs to guess at. */
export async function listPublicQuestions() {
  const { data, error } = await supabaseAdmin()
    .from("wellness_questions")
    .select("id, question, dimension, sort_order, wellness_question_options(id, label, dosha, sort_order, goal:categories!goal_id(id,name,slug), concern:categories!concern_id(id,name,slug))")
    .eq("status", "published")
    .order("sort_order");
  if (error) throw error;
  return (data || [])
    .map((q) => ({ ...q, wellness_question_options: (q.wellness_question_options || []).sort((a, b) => a.sort_order - b.sort_order) }))
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Scores and (for a logged-in customer) persists one assessment
 * submission. `answers` is [{question_id, option_id}] - every pair is
 * re-validated server-side against real, currently-published questions/
 * options (never trust the client's claimed dosha/goal/concern the way
 * the old client-only dosha-test.html did - Phase 4 audit's own
 * recommendation to move this server-side).
 *
 * Returns { resultDosha, goalIds, concernIds, saved }. Throws a plain
 * Error with `.status`/`.expose` (same AppError-less convention as this
 * app's older routes - see products.js) for invalid input.
 */
export async function submitAssessment(customerId, answers) {
  if (!Array.isArray(answers) || !answers.length) {
    const e = new Error("answers is required"); e.status = 400; e.expose = true; throw e;
  }

  const optionIds = [...new Set(answers.map((a) => a?.option_id).filter(Boolean))];
  if (!optionIds.length) {
    const e = new Error("Each answer must include option_id"); e.status = 400; e.expose = true; throw e;
  }

  // Re-fetch the real options from the DB (joined to their question's
  // dimension + published status) - the client only ever sends ids, never
  // the dosha/goal/concern value itself, so there is nothing for a
  // tampered request to lie about.
  const { data: options, error } = await supabaseAdmin()
    .from("wellness_question_options")
    .select("id, question_id, dosha, goal_id, concern_id, wellness_questions!inner(id, dimension, status)")
    .in("id", optionIds);
  if (error) throw error;

  const optionById = new Map((options || []).map((o) => [o.id, o]));
  const doshaVotes = { vata: 0, pitta: 0, kapha: 0 };
  const goalIds = new Set();
  const concernIds = new Set();

  for (const answer of answers) {
    const option = optionById.get(answer?.option_id);
    // Silently skip anything that doesn't resolve to a real, currently-
    // published option (deleted/unpublished since the client loaded the
    // quiz, or a malformed id) - never let unverifiable input influence
    // the score, but also never hard-fail a whole submission over one
    // stale answer.
    if (!option || option.wellness_questions?.status !== "published") continue;
    if (option.question_id !== answer.question_id) continue; // option must belong to the stated question
    if (option.dosha) doshaVotes[option.dosha] += 1;
    else if (option.goal_id) goalIds.add(option.goal_id);
    else if (option.concern_id) concernIds.add(option.concern_id);
  }

  const totalDoshaVotes = DOSHAS.reduce((sum, d) => sum + doshaVotes[d], 0);
  if (totalDoshaVotes === 0) {
    const e = new Error("At least one dosha question must be answered"); e.status = 400; e.expose = true; throw e;
  }
  // Deterministic tie-break: DOSHAS' fixed order (vata, pitta, kapha) -
  // same "first max wins" behaviour as the original client-side
  // `Object.entries(counts).sort(...)[0]` in dosha-test.html.
  const resultDosha = DOSHAS.reduce((best, d) => (doshaVotes[d] > doshaVotes[best] ? d : best), DOSHAS[0]);

  const goalIdList = [...goalIds];
  const concernIdList = [...concernIds];

  let saved = false;
  if (customerId) {
    const { data: assessment, error: insError } = await supabaseAdmin()
      .from("wellness_assessments")
      .insert({ customer_id: customerId, answers, result_dosha: resultDosha })
      .select().single();
    if (insError) throw insError;

    // Replace the customer's CURRENT goal/concern tag sets wholesale -
    // same "delete then insert the new full set" shape as
    // products.js's PUT /:id/relationships, keeping "current profile"
    // consistent with "most recent submission" by construction.
    await supabaseAdmin().from("customer_wellness_goals").delete().eq("customer_id", customerId);
    await supabaseAdmin().from("customer_wellness_concerns").delete().eq("customer_id", customerId);
    if (goalIdList.length) {
      await supabaseAdmin().from("customer_wellness_goals")
        .insert(goalIdList.map((goal_id) => ({ customer_id: customerId, goal_id, assessment_id: assessment.id })));
    }
    if (concernIdList.length) {
      await supabaseAdmin().from("customer_wellness_concerns")
        .insert(concernIdList.map((concern_id) => ({ customer_id: customerId, concern_id, assessment_id: assessment.id })));
    }
    saved = true;
  }

  return { resultDosha, goalIds: goalIdList, concernIds: concernIdList, saved };
}

/** The customer's current profile (derived from their most recent
 * wellness_assessments row - never a separately-maintained table that
 * could drift out of sync) plus their full assessment history. Returns
 * `current: null` for a customer who has never completed the assessment. */
export async function getProfile(customerId) {
  const { data: history, error } = await supabaseAdmin()
    .from("wellness_assessments")
    .select("id, result_dosha, created_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  if (!history || !history.length) return { current: null, history: [] };

  const [{ data: goals }, { data: concerns }] = await Promise.all([
    supabaseAdmin().from("customer_wellness_goals").select("goal_id, categories(id,name,slug)").eq("customer_id", customerId),
    supabaseAdmin().from("customer_wellness_concerns").select("concern_id, categories(id,name,slug)").eq("customer_id", customerId),
  ]);

  return {
    current: {
      dosha: history[0].result_dosha,
      assessedAt: history[0].created_at,
      goals: (goals || []).map((g) => g.categories).filter(Boolean),
      concerns: (concerns || []).map((c) => c.categories).filter(Boolean),
    },
    history,
  };
}

/** Thin orchestration: derive this customer's current profile signals,
 * hand them to catalogService's customer-agnostic matcher. Returns
 * `{ items: [], total: 0, matchType: "no_profile" }` (not an error) for a
 * customer who hasn't completed the assessment yet - "no recommendations
 * yet" is a normal, expected state, not a failure. */
export async function getRecommendedProducts(customerId, { page = 1, pageSize = 12, sort } = {}) {
  const { current } = await getProfile(customerId);
  if (!current) return { items: [], total: 0, matchType: "no_profile" };
  return catalogGetRecommendedProducts({
    dosha: current.dosha,
    goalIds: current.goals.map((g) => g.id),
    concernIds: current.concerns.map((c) => c.id),
    page, pageSize, sort,
  });
}

/**
 * Predefined, admin-authored routine templates only - this never composes
 * or generates a routine, it only selects among ones staff already wrote.
 * Match rule (all of it, nothing hidden): a routine matches if
 * (its dosha is unset, meaning "suits everyone", OR equals the customer's
 * dosha) AND (it has no goal tags at all, OR at least one of its goal
 * tags is also one of the customer's current goals).
 */
export async function getRecommendedRoutines(customerId) {
  const { current } = await getProfile(customerId);
  if (!current) return { items: [], matchType: "no_profile" };

  const { data: routines, error } = await supabaseAdmin()
    .from("routine_templates")
    .select("id, name, slug, description, dosha, routine_goals(goal_id)")
    .eq("status", "published")
    .order("sort_order");
  if (error) throw error;

  const customerGoalIds = new Set(current.goals.map((g) => g.id));
  const matched = (routines || []).filter((r) => {
    const doshaOk = !r.dosha || r.dosha === current.dosha;
    const goalTags = (r.routine_goals || []).map((g) => g.goal_id);
    const goalOk = !goalTags.length || goalTags.some((id) => customerGoalIds.has(id));
    return doshaOk && goalOk;
  }).map(({ routine_goals, ...r }) => r);

  return { items: matched, matchType: matched.length ? "dosha_and_goal_rules" : "no_matching_routines" };
}
