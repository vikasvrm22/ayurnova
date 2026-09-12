/**
 * DEV Harness - deterministic local test data.
 *
 * Phase 0 flagged that the only configured Supabase project might be a
 * real/production one (ASSUMPTION, never resolved - the user chose to
 * rotate credentials themselves rather than confirm). This script
 * therefore:
 *   - NEVER runs unless DEV_HARNESS_ALLOW_WRITE=true is explicitly set
 *     (a plain `node dev-harness/seed-test-data.js` is always a no-op).
 *   - Only ever INSERTS one clearly-marked, DRAFT category + product
 *     (draft products never appear on the public storefront - see
 *     supabase/schema.sql's "public read published products" RLS policy
 *     and every public query's `.eq("status","published")` filter).
 *   - Is idempotent: re-running it finds the existing fixture by its fixed
 *     slug and does nothing, rather than creating duplicates.
 *   - Never updates or deletes anything that isn't this fixture's own row.
 *
 * This gives API/E2E tests one stable, known product to exercise
 * (list/detail/pagination/sorting) without depending on whatever real
 * catalog state happens to exist, and without risking real data.
 *
 * Usage:
 *   DEV_HARNESS_ALLOW_WRITE=true npm run dev:seed-test-data
 */
import "dotenv/config.js";
import { createClient } from "@supabase/supabase-js";

const FIXTURE_CATEGORY_SLUG = "phase1-dev-harness-concern";
const FIXTURE_PRODUCT_SLUG = "phase1-dev-harness-test-product";

async function main() {
  if (process.env.DEV_HARNESS_ALLOW_WRITE !== "true") {
    console.log("DEV_HARNESS_ALLOW_WRITE is not set to 'true' - refusing to write anything.");
    console.log("This is intentional: the only configured database may not be a throwaway dev project.");
    console.log("Set DEV_HARNESS_ALLOW_WRITE=true only if you have confirmed it is safe to add test rows.");
    process.exit(0);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - see server/.env.example.");
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let { data: category } = await supabase.from("categories").select("id").eq("slug", FIXTURE_CATEGORY_SLUG).maybeSingle();
  if (!category) {
    const { data, error } = await supabase
      .from("categories")
      .insert({ name: "Phase 1 DEV Harness Fixture", slug: FIXTURE_CATEGORY_SLUG, type: "concern", sort_order: 9999 })
      .select()
      .single();
    if (error) throw error;
    category = data;
    console.log(`Created fixture category: ${category.id} (${FIXTURE_CATEGORY_SLUG})`);
  } else {
    console.log(`Fixture category already exists: ${category.id} (${FIXTURE_CATEGORY_SLUG}) - leaving as-is.`);
  }

  let { data: product } = await supabase.from("products").select("id").eq("slug", FIXTURE_PRODUCT_SLUG).maybeSingle();
  if (!product) {
    const { data, error } = await supabase
      .from("products")
      .insert({
        title: "Phase 1 DEV Harness Test Product - DO NOT PUBLISH",
        slug: FIXTURE_PRODUCT_SLUG,
        category_id: category.id,
        short_description: "Fixture product line 1\nFixture product line 2",
        description: "This row exists only for DEV/QA harness automation (Phase 1). Safe to ignore in the admin panel; never published, never shown on the storefront.",
        status: "draft", // intentionally never published - must never reach real shoppers
        created_by: "dev-harness",
        updated_by: "dev-harness",
      })
      .select()
      .single();
    if (error) throw error;
    product = data;
    console.log(`Created fixture product: ${product.id} (${FIXTURE_PRODUCT_SLUG}, status=draft)`);

    const { error: variantError } = await supabase.from("product_variants").insert({
      product_id: product.id, label: "Fixture Pack", price: 1, mrp: 1, stock: 10,
    });
    if (variantError) throw variantError;
    console.log("Created fixture variant.");
  } else {
    console.log(`Fixture product already exists: ${product.id} (${FIXTURE_PRODUCT_SLUG}) - leaving as-is.`);
  }

  console.log("\nDone. This fixture stays in 'draft' status and will never appear on the public site.");
  console.log("To use it in a test that needs a PUBLISHED product, publish it manually via the admin panel");
  console.log("and remember to archive/delete it again afterwards - this script will not do that for you.");
}

main().catch((e) => {
  console.error("dev-harness seed failed:", e.message);
  process.exit(1);
});
