import geoip from "geoip-lite";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { config } from "../config.js";
import { logError } from "../services/errorLogService.js";

let buffer = [];

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "";
}

export function trackPageView(req, res, next) {
  try {
    const ip = getClientIp(req);
    const geo = ip && ip !== "::1" && ip !== "127.0.0.1" ? geoip.lookup(ip) : null;

    buffer.push({
      path: req.path,
      at: new Date().toISOString(),
      ip: ip || "",
      country: geo?.country || "Unknown",
      region: geo?.region || "",
      city: geo?.city || "",
      user_agent: (req.headers["user-agent"] || "").slice(0, 200),
      referrer: (req.headers["referer"] || "").slice(0, 200),
    });

    if (buffer.length >= config.analytics.maxBufferSize) {
      flush().catch((e) => console.error("Analytics flush (buffer full) failed:", e));
    }
  } catch (e) {
    console.error("trackPageView error (non-fatal):", e);
  }
  next();
}

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    const { error } = await supabaseAdmin().from("page_views").insert(batch);
    if (error) throw error;
  } catch (e) {
    console.error(`Failed to flush ${batch.length} analytics events:`, e.message);
    logError("analytics_flush", e, { batchSize: batch.length });
  }
}

export function startAnalyticsFlusher() {
  setInterval(() => {
    flush().catch((e) => console.error("Analytics flush failed:", e));
  }, config.analytics.flushIntervalMs);
}

export function flushNow() {
  return flush();
}
