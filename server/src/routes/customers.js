import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";

const router = Router();

router.use(requireStaffAuth, requirePermission("viewCustomers"));

router.get("/", async (req, res, next) => {
  try {
    const { page = 1, pageSize = 20 } = req.query;
    const p = Math.max(1, Number(page));
    const ps = Math.max(1, Number(pageSize));

    // Supabase Auth admin API - lists registered storefront customers.
    const { data: userList, error } = await supabaseAdmin().auth.admin.listUsers({ page: p, perPage: ps });
    if (error) throw error;

    const { data: orderRows } = await supabaseAdmin().from("orders").select("customer_id, total");
    const byCustomer = {};
    for (const row of orderRows || []) {
      if (!row.customer_id) continue;
      byCustomer[row.customer_id] = byCustomer[row.customer_id] || { count: 0, total: 0 };
      byCustomer[row.customer_id].count += 1;
      byCustomer[row.customer_id].total += Number(row.total || 0);
    }

    const items = userList.users.map((u) => ({
      id: u.id,
      email: u.email,
      phone: u.phone || u.user_metadata?.phone || "",
      created_at: u.created_at,
      order_count: byCustomer[u.id]?.count || 0,
      total_spent: byCustomer[u.id]?.total || 0,
    }));

    res.json({ items, page: p, pageSize: ps });
  } catch (e) {
    next(e);
  }
});

router.get("/:id/orders", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("orders").select("*").eq("customer_id", req.params.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

export default router;
