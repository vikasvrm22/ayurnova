import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { validateTaxProfile } from "../validation/validators.js";

const router = Router();

// Phase 8A: the generic settings PUT below accepts any key/value blob
// with zero validation - fine for most keys (trust_badges, social_links,
// etc), but tax_profile's GSTIN/pricing_mode/state_code feed directly
// into invoice generation and real money calculations, so it gets one
// dedicated shape check here rather than a silent bad-value write. Every
// other settings key is completely unaffected.
const KEY_VALIDATORS = { tax_profile: validateTaxProfile };

router.get("/", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("settings").select("*");
    if (error) throw error;
    const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
    res.json({ settings: map });
  } catch (e) {
    next(e);
  }
});

router.put("/:key", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { value } = req.body || {};
    const validator = KEY_VALIDATORS[req.params.key];
    if (validator) {
      const { valid, errors } = validator(value || {});
      if (!valid) return res.status(400).json({ error: "Validation failed", fields: errors });
    }
    const { error } = await supabaseAdmin().from("settings").upsert({
      key: req.params.key, value, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
