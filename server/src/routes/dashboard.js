import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";

const router = Router();
router.use(requireStaffAuth);

router.get("/summary", async (req, res, next) => {
  try {
    const range = req.query.range || "week"; // today|week|month|year
    const now = Date.now();
    const windowMs = { today: 1, week: 7, month: 30, year: 365 }[range] * 24 * 60 * 60 * 1000;
    const since = new Date(now - windowMs).toISOString();

    const { data: recentOrders } = await supabaseAdmin()
      .from("orders").select("*").gte("created_at", since);

    const revenue = (recentOrders || []).reduce((sum, o) => sum + Number(o.total || 0), 0);
    const orderCount = (recentOrders || []).length;
    const avgOrderValue = orderCount ? Math.round(revenue / orderCount) : 0;
    const pendingShipments = (recentOrders || []).filter((o) => o.status === "processing").length;

    const { data: lowStockVariants } = await supabaseAdmin()
      .from("product_variants").select("id").lte("stock", 10).gt("stock", 0);
    const { data: outOfStockVariants } = await supabaseAdmin()
      .from("product_variants").select("id").eq("stock", 0);

    // Top-selling products by units sold in the window - only fetch items
    // belonging to orders actually in this window, not the whole table.
    const orderIdsInWindow = (recentOrders || []).map((o) => o.id);
    const { data: itemsInWindow } = orderIdsInWindow.length
      ? await supabaseAdmin().from("order_items").select("product_id, title_snapshot, qty, subtotal, order_id").in("order_id", orderIdsInWindow)
      : { data: [] };
    const byProduct = {};
    for (const item of itemsInWindow || []) {
      const key = item.product_id || item.title_snapshot;
      byProduct[key] = byProduct[key] || { title: item.title_snapshot, units: 0, revenue: 0 };
      byProduct[key].units += item.qty;
      byProduct[key].revenue += Number(item.subtotal || 0);
    }
    const topProducts = Object.values(byProduct).sort((a, b) => b.units - a.units).slice(0, 5);

    const { data: latestOrders } = await supabaseAdmin()
      .from("orders").select("id, order_number, status, total, guest_email").order("created_at", { ascending: false }).limit(5);

    // All-time catalog/order totals for the summary stat cards (independent of
    // the `range` window, which only scopes revenue/orders/top-products above).
    const { count: totalProductsCount } = await supabaseAdmin().from("products").select("id", { count: "exact", head: true });
    const { count: totalCategoriesCount } = await supabaseAdmin().from("categories").select("id", { count: "exact", head: true });
    const { count: totalOrdersCount } = await supabaseAdmin().from("orders").select("id", { count: "exact", head: true });
    const { data: allCustomerIds } = await supabaseAdmin().from("orders").select("customer_id").not("customer_id", "is", null);
    const totalCustomersCount = new Set((allCustomerIds || []).map((o) => o.customer_id)).size;

    const ordersByStatus = {};
    for (const o of recentOrders || []) ordersByStatus[o.status] = (ordersByStatus[o.status] || 0) + 1;

    res.json({
      revenue, orderCount, avgOrderValue, pendingShipments,
      lowStockCount: (lowStockVariants || []).length,
      outOfStockCount: (outOfStockVariants || []).length,
      topProducts, recentOrders: latestOrders || [],
      totalProductsCount: totalProductsCount || 0,
      totalCategoriesCount: totalCategoriesCount || 0,
      totalOrdersCount: totalOrdersCount || 0,
      totalCustomersCount,
      ordersByStatus,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
