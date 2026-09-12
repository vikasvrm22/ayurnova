import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";

const router = Router();
router.use(requireStaffAuth);

function bucketKey(date, range) {
  const d = new Date(date);
  if (range === "daily") return d.toISOString().slice(0, 10);
  if (range === "weekly") {
    const day = d.getUTCDay() || 7;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day + 1);
    return monday.toISOString().slice(0, 10);
  }
  if (range === "monthly") return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${d.getUTCFullYear()}`;
}

function rangeWindowMs(range) {
  const day = 24 * 60 * 60 * 1000;
  switch (range) {
    case "daily": return 30 * day;
    case "weekly": return 12 * 7 * day;
    case "monthly": return 365 * day;
    case "yearly": return 5 * 365 * day;
    default: return 30 * day;
  }
}

router.get("/summary", async (req, res, next) => {
  try {
    const range = ["daily", "weekly", "monthly", "yearly"].includes(req.query.range) ? req.query.range : "daily";
    const now = Date.now();
    const windowStart = new Date(now - rangeWindowMs(range)).toISOString();

    const { data: inWindow, error } = await supabaseAdmin()
      .from("page_views").select("at, country, region").gte("at", windowStart);
    if (error) throw error;

    const buckets = {};
    for (const r of inWindow || []) {
      const key = bucketKey(r.at, range);
      buckets[key] = (buckets[key] || 0) + 1;
    }
    const timeSeries = Object.entries(buckets).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, count]) => ({ label, count }));

    const byCountry = {}, byRegion = {};
    for (const r of inWindow || []) {
      const country = r.country || "Unknown";
      byCountry[country] = (byCountry[country] || 0) + 1;
      if (country === "IN" && r.region) byRegion[r.region] = (byRegion[r.region] || 0) + 1;
    }
    const topCountries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, count]) => ({ label, count }));
    const topRegions = Object.entries(byRegion).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, count]) => ({ label, count }));

    const { count: today } = await supabaseAdmin().from("page_views").select("*", { count: "exact", head: true }).gte("at", new Date(now - 24 * 60 * 60 * 1000).toISOString());
    const { count: thisWeek } = await supabaseAdmin().from("page_views").select("*", { count: "exact", head: true }).gte("at", new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());
    const { count: thisMonth } = await supabaseAdmin().from("page_views").select("*", { count: "exact", head: true }).gte("at", new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString());
    const { count: thisYear } = await supabaseAdmin().from("page_views").select("*", { count: "exact", head: true }).gte("at", new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString());
    const { count: allTime } = await supabaseAdmin().from("page_views").select("*", { count: "exact", head: true });

    res.json({
      range, timeSeries, topCountries, topRegions,
      totals: { today: today || 0, thisWeek: thisWeek || 0, thisMonth: thisMonth || 0, thisYear: thisYear || 0, allTime: allTime || 0 },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
