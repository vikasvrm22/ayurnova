import { Router } from "express";
import multer from "multer";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { sanitizeText } from "../validation/validators.js";
import { uploadMediaAsset, deleteMediaAsset } from "../storage/imageUpload.js";

// Phase UI-1: Admin "Banners & Media" library. Generic (non-product) image
// upload/list/toggle/delete over the `media_assets` table added in
// supabase/migrations/0013_phase_ui1_media_assets.sql. Gated behind
// manageSettings, the same permission that already covers the rest of the
// admin-only "site configuration" surface (Settings/Integrations).

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get("/", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("media_assets").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageSettings"), upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file uploaded" });
    const { title, placement, source_note } = req.body || {};
    if (!title) return res.status(400).json({ error: "title is required" });

    const uploaded = await uploadMediaAsset(req.file);
    const { data, error } = await supabaseAdmin().from("media_assets").insert({
      title: sanitizeText(title.trim()),
      placement: placement ? sanitizeText(placement.trim()) : null,
      url: uploaded.url,
      storage_path: uploaded.path,
      width: uploaded.width,
      height: uploaded.height,
      size_bytes: uploaded.sizeBytes,
      format: uploaded.format,
      source_note: source_note ? sanitizeText(source_note.trim()) : null,
      uploaded_by: req.staff.id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { active, title, placement } = req.body || {};
    const patch = {};
    if (active !== undefined) patch.active = Boolean(active);
    if (title !== undefined) patch.title = sanitizeText(title.trim());
    if (placement !== undefined) patch.placement = placement ? sanitizeText(placement.trim()) : null;
    const { data, error } = await supabaseAdmin().from("media_assets").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { data: existing } = await supabaseAdmin().from("media_assets").select("storage_path").eq("id", req.params.id).maybeSingle();
    const { error } = await supabaseAdmin().from("media_assets").delete().eq("id", req.params.id);
    if (error) throw error;
    if (existing?.storage_path) await deleteMediaAsset(existing.storage_path).catch(() => {});
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
