import { Router } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { signStaffToken, requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { validateEmail, validatePassword } from "../validation/validators.js";
import { ROLES } from "../config.js";

const router = Router();

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!validateEmail(email) || !password) {
      return res.status(400).json({ error: "Valid email and password required" });
    }
    const { data: staff, error } = await supabaseAdmin()
      .from("staff_users")
      .select("*")
      .ilike("email", email)
      .maybeSingle();
    if (error) throw error;
    if (!staff || staff.status === "deactivated") {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const ok = await bcrypt.compare(password, staff.password_hash || "");
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = signStaffToken(staff);
    res.json({ token, user: { id: staff.id, email: staff.email, role: staff.role, name: staff.name } });
  } catch (e) {
    next(e);
  }
});

router.get("/me", requireStaffAuth, (req, res) => {
  res.json({ user: req.staff });
});

router.post("/change-password", requireStaffAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !validatePassword(newPassword)) {
      return res.status(400).json({ error: "Current password and a new password (10+ chars, letter+number) required" });
    }
    const { data: staff, error } = await supabaseAdmin().from("staff_users").select("*").eq("id", req.staff.id).single();
    if (error) throw error;

    const ok = await bcrypt.compare(currentPassword, staff.password_hash || "");
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

    const hash = await bcrypt.hash(newPassword, 10);
    const { error: updateError } = await supabaseAdmin().from("staff_users").update({ password_hash: hash }).eq("id", staff.id);
    if (updateError) throw updateError;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.post("/complete-setup", async (req, res, next) => {
  try {
    const { setupToken, password } = req.body || {};
    if (!setupToken || !validatePassword(password)) {
      return res.status(400).json({ error: "Valid setup token and a password (10+ chars, letter+number) required" });
    }
    const { data: staff, error } = await supabaseAdmin()
      .from("staff_users").select("*").eq("setup_token", setupToken).eq("status", "invited").maybeSingle();
    if (error) throw error;
    if (!staff) return res.status(400).json({ error: "Invalid or already-used setup link" });

    const hash = await bcrypt.hash(password, 10);
    const { error: updateError } = await supabaseAdmin()
      .from("staff_users").update({ password_hash: hash, status: "active", setup_token: null }).eq("id", staff.id);
    if (updateError) throw updateError;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- Staff management (SuperAdmin/Admin only) ----
router.get("/staff", requireStaffAuth, requirePermission("manageUsers"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("staff_users").select("id,email,name,role,status,created_at");
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

const ROLE_RANK = { Viewer: 1, Editor: 2, Admin: 3, SuperAdmin: 4 };

router.post("/staff/invite", requireStaffAuth, requirePermission("manageUsers"), async (req, res, next) => {
  try {
    const { email, name, role } = req.body || {};
    if (!validateEmail(email) || !name || !ROLES.includes(role)) {
      return res.status(400).json({ error: "Valid email, name and role required" });
    }
    if (ROLE_RANK[role] > ROLE_RANK[req.staff.role]) {
      return res.status(403).json({ error: "You cannot assign a role higher than your own" });
    }
    const { data: existing } = await supabaseAdmin().from("staff_users").select("id").ilike("email", email).maybeSingle();
    if (existing) return res.status(409).json({ error: "A user with this email already exists" });

    const setupToken = uuid();
    const { error } = await supabaseAdmin().from("staff_users").insert({
      email, name, role, status: "invited", setup_token: setupToken, password_hash: "", invited_by: req.staff.email,
    });
    if (error) throw error;
    res.status(201).json({ success: true, setupLink: `/complete-setup.html?token=${setupToken}` });
  } catch (e) {
    next(e);
  }
});

router.put("/staff/:id", requireStaffAuth, requirePermission("manageUsers"), async (req, res, next) => {
  try {
    const { role, name } = req.body || {};
    if (role && ROLE_RANK[role] > ROLE_RANK[req.staff.role]) {
      return res.status(403).json({ error: "You cannot assign a role higher than your own" });
    }
    const patch = {};
    if (role) patch.role = role;
    if (name) patch.name = name;
    const { data, error } = await supabaseAdmin().from("staff_users").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/staff/:id/deactivate", requireStaffAuth, requirePermission("manageUsers"), async (req, res, next) => {
  try {
    const { data: target } = await supabaseAdmin().from("staff_users").select("*").eq("id", req.params.id).single();
    if (!target) return res.status(404).json({ error: "User not found" });

    if (target.role === "SuperAdmin") {
      const { data: activeSuperAdmins } = await supabaseAdmin()
        .from("staff_users").select("id").eq("role", "SuperAdmin").eq("status", "active");
      if ((activeSuperAdmins || []).length <= 1) {
        return res.status(400).json({ error: "Cannot deactivate the last remaining Super Admin" });
      }
    }
    const { error } = await supabaseAdmin().from("staff_users").update({ status: "deactivated" }).eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
